/**
 * audioEngine.js
 * -----------------------------------------------------------------------------
 * Camada de infraestrutura de áudio de baixo nível.
 *
 * Responsabilidade única: gerenciar o CICLO DE VIDA do áudio, não a lógica do
 * motor. Concretamente ele:
 *   1. Possui o ÚNICO AudioContext da aplicação (singleton por instância).
 *   2. Carrega e decodifica cada arquivo WAV EXATAMENTE UMA VEZ, guardando os
 *      AudioBuffers imutáveis num Map para reuso.
 *   3. Expõe a cadeia master (masterGain -> destination) e fábricas de nós.
 *
 * Regras de performance impostas por design:
 *   - Um único AudioContext, criado após gesto do usuário (política de autoplay).
 *   - Buffers decodificados uma vez; nunca recriados. AudioBuffers são imutáveis
 *     e podem ser tocados por infinitos BufferSources.
 *
 * Este módulo NÃO conhece "RPM", "marcha" nem "starter". Camadas superiores
 * (engine, gearbox, vehicle) usam esta API para produzir som. Manter essa
 * fronteira limpa é o que torna a arquitetura escalável.
 * -----------------------------------------------------------------------------
 */

import { clamp, equalPowerCrossfade, delay } from './utils.js';

/**
 * Manifesto de áudio: nome lógico -> caminho do arquivo.
 *
 * O "nome lógico" é a chave usada em todo o código (ex.: 'rpm_4500'); o caminho
 * é um detalhe de armazenamento que fica isolado aqui. Se um arquivo mudar de
 * lugar, muda-se só esta tabela.
 * @type {Readonly<Record<string, string>>}
 */
export const AUDIO_MANIFEST = Object.freeze({
  // Interface
  display: 'audio/display.ogg', // clique da chave que liga o painel
  fuel_pump: 'audio/fuel_pump.ogg', // escorva da bomba de combustível (na inicialização)

  // Eventos de ciclo de vida do motor
  starter: 'audio/starter.ogg',
  engine_off: 'audio/engine_off.ogg',
  idle: 'audio/idle.ogg',

  // Camadas de RPM (loops contínuos)
  rpm_1500: 'audio/rpm_1500.ogg',
  rpm_2500: 'audio/rpm_2500.ogg',
  rpm_3500: 'audio/rpm_3500.ogg',
  rpm_4500: 'audio/rpm_4500.ogg',
  rpm_5500: 'audio/rpm_5500.ogg',
  rpm_6500: 'audio/rpm_6500.ogg',
  rpm_7500: 'audio/rpm_7500.ogg',
  rpm_8200: 'audio/rpm_8200.ogg',
  rpm_8500: 'audio/rpm_8500.ogg',

  // Camada de corte
  rev_limiter: 'audio/rev_limiter.ogg',

  // Camadas de acelerador
  throttle_on: 'audio/throttle_on.ogg',
  throttle_off: 'audio/throttle_off.ogg',

  // Eventos de câmbio
  gear_up: 'audio/gear_up.ogg',
  gear_down_even: 'audio/gear_down_even.ogg',
  gear_down_odd: 'audio/gear_down_odd.ogg',
});

export class AudioEngine {
  constructor() {
    /**
     * O único AudioContext. Criado preguiçosamente em unlock() para respeitar a
     * política de autoplay dos navegadores (precisa de gesto do usuário).
     * @type {AudioContext | null}
     */
    this._ctx = null;

    /**
     * Nó de ganho master: todo som passa por ele antes do destino. Ponto único
     * para volume global e futuras inserções (compressor/limiter).
     * @type {GainNode | null}
     */
    this._masterGain = null;

    /**
     * Cache imutável de buffers decodificados: nome lógico -> AudioBuffer.
     * @type {Map<string, AudioBuffer>}
     */
    this._buffers = new Map();

    /** Evita disparar o carregamento mais de uma vez. @type {Promise<void>|null} */
    this._loadPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida do contexto
  // ---------------------------------------------------------------------------

  /**
   * Cria (na primeira chamada) e retoma o AudioContext.
   *
   * DEVE ser chamado a partir de um manipulador de gesto do usuário (clique,
   * toque, tecla), caso contrário o navegador manterá o contexto suspenso e não
   * sairá som algum.
   * @returns {Promise<void>}
   */
  /**
   * Cria o AudioContext (e a cadeia master) SEM retomá-lo. Pode ser chamado sem
   * gesto do usuário: o contexto nasce 'suspended', mas isso já basta para
   * DECODIFICAR áudio em segundo plano (pré-carregamento). O som só sai após
   * resume()/unlock(), que exigem gesto.
   */
  prepare() {
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio API não é suportada neste navegador.');

    this._ctx = new Ctx({ latencyHint: 'interactive' });

    // Cadeia master: masterGain -> destination.
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = 1.0;
    this._masterGain.connect(this._ctx.destination);
  }

  /**
   * Garante o contexto e o RETOMA. DEVE ser chamado a partir de um gesto do
   * usuário (clique/toque/tecla), senão o contexto fica suspenso e não sai som.
   * @returns {Promise<void>}
   */
  async unlock() {
    this.prepare();
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }
  }

  /** @returns {AudioContext} O contexto (lança se ainda não foi feito unlock). */
  get context() {
    if (!this._ctx) throw new Error('AudioEngine: chame unlock() antes de usar o contexto.');
    return this._ctx;
  }

  /** @returns {GainNode} O nó de ganho master. */
  get masterGain() {
    if (!this._masterGain) throw new Error('AudioEngine: cadeia master indisponível (faça unlock()).');
    return this._masterGain;
  }

  /** @returns {number} Tempo atual do contexto em segundos (relógio de áudio). */
  get now() {
    return this.context.currentTime;
  }

  /**
   * Define o volume master de forma suave (evita cliques por salto brusco).
   * @param {number} value  Ganho linear [0..1+].
   * @param {number} [rampSeconds=0.05]
   */
  setMasterVolume(value, rampSeconds = 0.05) {
    const g = this.masterGain.gain;
    const t = this.now;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(clamp(value, 0, 4), t + Math.max(0.001, rampSeconds));
  }

  // ---------------------------------------------------------------------------
  // Carregamento de assets (uma única vez)
  // ---------------------------------------------------------------------------

  /**
   * Carrega e decodifica todos os arquivos do manifesto. Idempotente: chamadas
   * repetidas retornam a mesma Promise e nunca recarregam ou redecodificam.
   *
   * @param {(loaded: number, total: number, name: string) => void} [onProgress]
   *        Callback opcional de progresso (para a barra de carregamento).
   * @returns {Promise<void>}
   */
  loadAll(onProgress) {
    if (this._loadPromise) return this._loadPromise;

    const entries = Object.entries(AUDIO_MANIFEST);
    const total = entries.length;
    let loaded = 0;

    this._loadPromise = (async () => {
      // Carrega em paralelo, mas reporta progresso conforme cada um conclui.
      // Pula o que já estiver em cache (ex.: 'display' carregado avulso antes).
      await Promise.all(
        entries.map(async ([name, path]) => {
          if (!this._buffers.has(name)) {
            const buffer = await this._loadOne(path);
            this._buffers.set(name, buffer);
          }
          loaded += 1;
          if (onProgress) onProgress(loaded, total, name);
        }),
      );
    })();

    return this._loadPromise;
  }

  /**
   * Carrega e decodifica UM asset pelo nome lógico (se ainda não estiver em
   * cache). Útil para tocar um som imediatamente antes de carregar o resto.
   * @param {string} name
   * @returns {Promise<AudioBuffer>}
   */
  async loadOne(name) {
    if (this._buffers.has(name)) return this.getBuffer(name);
    const path = AUDIO_MANIFEST[name];
    if (!path) throw new Error(`AudioEngine: asset "${name}" não está no manifesto.`);
    const buffer = await this._loadOne(path);
    this._buffers.set(name, buffer);
    return buffer;
  }

  /**
   * Busca e decodifica um único arquivo em AudioBuffer.
   * @param {string} path
   * @returns {Promise<AudioBuffer>}
   * @private
   */
  async _loadOne(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Falha ao carregar áudio "${path}": HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    // decodeAudioData retorna Promise nos navegadores modernos.
    return await this.context.decodeAudioData(arrayBuffer);
  }

  /**
   * Recupera um buffer já decodificado pelo nome lógico.
   * @param {string} name
   * @returns {AudioBuffer}
   */
  getBuffer(name) {
    const buffer = this._buffers.get(name);
    if (!buffer) throw new Error(`AudioEngine: buffer "${name}" não carregado.`);
    return buffer;
  }

  /** @returns {boolean} Verdadeiro se todos os buffers do manifesto já existem. */
  get isLoaded() {
    return this._buffers.size === Object.keys(AUDIO_MANIFEST).length;
  }

  // ---------------------------------------------------------------------------
  // Fábricas de nós (usadas pelas camadas superiores)
  // ---------------------------------------------------------------------------

  /**
   * Cria um GainNode desconectado. Conveniência para as camadas superiores
   * montarem suas próprias sub-cadeias sem tocar no AudioContext diretamente.
   * @param {number} [initialGain=1]
   * @returns {GainNode}
   */
  createGain(initialGain = 1) {
    const g = this.context.createGain();
    g.gain.value = initialGain;
    return g;
  }

  /**
   * Cria um AudioBufferSourceNode para um buffer nomeado.
   *
   * Lembrete importante da Web Audio API: um BufferSource é DESCARTÁVEL — só
   * pode ser iniciado uma vez. O buffer subjacente, porém, é reutilizado (nunca
   * recriamos AudioBuffers). Portanto criar sources é barato; o custo caro
   * (decodificação) aconteceu uma única vez no load.
   *
   * @param {string} name        Nome lógico do buffer.
   * @param {object} [options]
   * @param {boolean} [options.loop=false]
   * @param {number}  [options.playbackRate=1]
   * @returns {AudioBufferSourceNode}
   */
  createSource(name, { loop = false, playbackRate = 1 } = {}) {
    const source = this.context.createBufferSource();
    source.buffer = this.getBuffer(name);
    source.loop = loop;
    source.playbackRate.value = playbackRate;
    return source;
  }

  /**
   * Dispara um som NÃO-LOOP (one-shot) e o descarta ao terminar.
   *
   * Cria um BufferSource novo (descartável — só toca uma vez) sobre o buffer já
   * em cache; portanto é barato e nunca redecodifica. A limpeza dos nós ocorre
   * automaticamente no evento `ended`.
   *
   * @param {string} name
   * @param {object} [options]
   * @param {number}    [options.gain=1]
   * @param {number}    [options.playbackRate=1]
   * @param {AudioNode} [options.destination]  Padrão: masterGain.
   * @param {number}    [options.fadeIn=0]     Fade-in em segundos (evita clique).
   * @returns {{ source: AudioBufferSourceNode, gain: GainNode, duration: number }}
   */
  playOneShot(name, { gain = 1, playbackRate = 1, destination = null, fadeIn = 0 } = {}) {
    const dest = destination || this.masterGain;
    const source = this.createSource(name, { playbackRate });
    const g = this.createGain(fadeIn > 0 ? 0 : gain);
    source.connect(g).connect(dest);

    const t = this.now;
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + fadeIn);
    }

    source.start(t);
    source.onended = () => {
      source.disconnect();
      g.disconnect();
    };

    return { source, gain: g, duration: source.buffer.duration };
  }
}

/**
 * Camadas de RPM: nome lógico do buffer + a rotação (RPM) em que a amostra foi
 * gravada. A ORDEM importa (crescente) — o algoritmo de crossfade usa vizinhos
 * adjacentes. O idle entra como a camada mais grave, ancorada em IDLE_RPM.
 * @type {ReadonlyArray<{ name: string, rpm: number }>}
 */
export const RPM_LAYERS = Object.freeze([
  { name: 'idle', rpm: 1164 },
  { name: 'rpm_1500', rpm: 1500 },
  { name: 'rpm_2500', rpm: 2500 },
  { name: 'rpm_3500', rpm: 3500 },
  { name: 'rpm_4500', rpm: 4500 },
  { name: 'rpm_5500', rpm: 5500 },
  { name: 'rpm_6500', rpm: 6500 },
  { name: 'rpm_7500', rpm: 7500 },
  { name: 'rpm_8200', rpm: 8200 },
  { name: 'rpm_8500', rpm: 8500 },
]);

/**
 * Níveis de mixagem das camadas de evento. Centralizados para fácil ajuste.
 * @type {Readonly<object>}
 */
const MIX = Object.freeze({
  STARTER: 1.0,
  ENGINE_OFF: 1.0,
  THROTTLE_ON: 0.3,
  THROTTLE_OFF: 0.35,
  LIMITER: 0.8,
  GEAR_UP: 0.9,
  GEAR_DOWN: 0.9,
  DUCK_LEVEL: 0.45, // quanto o banco de RPM abaixa durante a troca
});

/**
 * EngineSound
 * -----------------------------------------------------------------------------
 * Produtor do SOM completo do motor. Reúne, num só grafo bem definido:
 *   - Banco de loops de RPM (crossfade equal-power + casamento de pitch).
 *   - Camada do rev limiter (loop sobreposto, sem cortar o principal).
 *   - One-shots misturados: starter, engine off, throttle on/off, trocas.
 *   - Ducking do banco durante as trocas de marcha.
 *
 * Invariantes (exigências do projeto):
 *   - Os loops de RPM começam em start() e NUNCA param para trocar de camada;
 *     só variam GANHO e PLAYBACKRATE.
 *   - Crossfade de POTÊNCIA CONSTANTE (nunca linear).
 *   - Nenhum evento (throttle/limitador/troca) interrompe o loop principal —
 *     todos se somam por barramentos paralelos.
 *
 * Grafo de áudio:
 *
 *   camadas RPM ─┐
 *                ├─> busGain ─┐                (busGain sofre "duck" na troca)
 *   (duck)       │            │
 *                            ├─> masterGain -> destination
 *   limiter ─────┐            │
 *   throttle ────┼─> fxGain ──┘                (fxGain: eventos, sem duck)
 *   one-shots (starter/off/troca) ─> masterGain  (direto)
 * -----------------------------------------------------------------------------
 */
export class EngineSound {
  /**
   * @param {AudioEngine} audioEngine  Núcleo de áudio já carregado.
   * @param {ReadonlyArray<{name:string,rpm:number}>} [layers]
   */
  constructor(audioEngine, layers = RPM_LAYERS) {
    this._audio = audioEngine;
    this._layers = layers;

    /** Barramento do banco de RPM (sofre duck na troca). @type {GainNode|null} */
    this._busGain = null;

    /** Barramento de efeitos contínuos (limitador/throttle). @type {GainNode|null} */
    this._fxGain = null;

    /**
     * Vozes do banco: uma por camada, criadas em start().
     * @type {Array<{ src: AudioBufferSourceNode, gain: GainNode, rpm: number }>}
     */
    this._voices = [];

    /** Voz do rev limiter (loop contínuo, ganho controlado). @type {object|null} */
    this._limiterVoice = null;

    this._started = false;

    /**
     * Camada de acelerador (throttle_on/off) ligada?
     *
     * DESLIGADA por padrão: só faz sentido com amostras CURTAS e transientes
     * (um "chiado" de admissão a cada toque). Se o throttle_on.wav/throttle_off
     * .wav forem varreduras LONGAS de aceleração (motor subindo até o corte),
     * mantê-la ligada faz cada toque "acelerar até o fim" por cima do banco de
     * RPM. Para reativar (com samples curtos), defina isto como true.
     * @type {boolean}
     */
    this.throttleLayerEnabled = false;

    /** Timer de restauração do duck (para cancelar sobreposições). */
    this._duckTimer = null;

    // Constantes de tempo dos filtros de parâmetro (segundos).
    this._gainTau = 0.02;
    this._rateTau = 0.012;
  }

  /** @returns {GainNode} Barramento do banco de RPM. */
  get busGain() {
    if (!this._busGain) throw new Error('EngineSound: chame start() antes de acessar o bus.');
    return this._busGain;
  }

  /** @returns {boolean} */
  get isStarted() {
    return this._started;
  }

  /**
   * Instancia e inicia todas as camadas de loop (RPM + limitador), todas em
   * ganho 0. O barramento do banco começa MUDO (busGain = 0): o som só surge
   * quando a ignição termina (ver ignite()). Idempotente.
   */
  start() {
    if (this._started) return;
    const audio = this._audio;

    // Barramento de eventos contínuos.
    this._fxGain = audio.createGain(1);
    this._fxGain.connect(audio.masterGain);

    // Barramento do banco de RPM: começa mudo até a ignição.
    this._busGain = audio.createGain(0);
    this._busGain.connect(audio.masterGain);

    // Camadas de RPM (loop contínuo).
    for (const layer of this._layers) {
      const src = audio.createSource(layer.name, { loop: true, playbackRate: 1 });
      const gain = audio.createGain(0);
      src.connect(gain).connect(this._busGain);
      src.start();
      this._voices.push({ src, gain, rpm: layer.rpm });
    }

    // Camada do rev limiter (loop contínuo, ganho 0 — só sobe quando cortando).
    {
      const src = audio.createSource('rev_limiter', { loop: true });
      const gain = audio.createGain(0);
      src.connect(gain).connect(this._fxGain);
      src.start();
      this._limiterVoice = { src, gain };
    }

    this._started = true;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida: ignição e desligamento (one-shots misturados)
  // ---------------------------------------------------------------------------

  /**
   * Sequência de ignição: toca o starter e revela o banco de RPM LOGO NO INÍCIO,
   * para que a subida de giro seja audível desde o começo da partida (o motor
   * "pega" já sob o starter, não depois dele). A combustão física (engine.start)
   * é disparada pelo orquestrador no início desta sequência.
   *
   * @param {number} [revealDelay=0.12] Atraso (s) até revelar o banco.
   * @returns {Promise<void>} Resolve quando o starter termina (trava a re-partida).
   */
  async ignite(revealDelay = 0.12) {
    const starter = this._audio.playOneShot('starter', { gain: MIX.STARTER });
    // Revela o banco cedo: a subida de RPM emerge desde o início, sob o starter.
    await delay(revealDelay * 1000);
    this.setBusGain(1, 0.2);
    // Segura a sequência até o starter terminar (evita re-partida sobreposta).
    await delay(Math.max(0, starter.duration - revealDelay) * 1000);
  }

  /**
   * Sequência de desligamento: toca engine_off e faz o fade-out dos loops
   * enquanto o RPM decai. A parada física é responsabilidade do orquestrador.
   *
   * @param {number} [fadeSeconds=0.9]
   * @returns {Promise<void>}
   */
  async shutdown(fadeSeconds = 0.9) {
    this._audio.playOneShot('engine_off', { gain: MIX.ENGINE_OFF });
    this.setLimiter(false);
    // tau ≈ fade/3 leva o ganho a ~95% do alvo dentro de fadeSeconds.
    this.setBusGain(0, fadeSeconds / 3);
    this._fadeFx(0, fadeSeconds / 3);
    await delay(fadeSeconds * 1000);
  }

  // ---------------------------------------------------------------------------
  // Banco de RPM
  // ---------------------------------------------------------------------------

  /**
   * Atualiza o banco para um RPM alvo. Deve ser chamado a cada frame.
   * @param {number} rpm  RPM alvo (recomenda-se o displayRpm filtrado do motor).
   */
  update(rpm) {
    if (!this._started) return;

    const voices = this._voices;
    const n = voices.length;
    const first = voices[0].rpm;
    const last = voices[n - 1].rpm;

    const rpmSel = clamp(rpm, first, last);

    // Encontra o par de âncoras [i, i+1] que envolve rpmSel.
    let i = 0;
    while (i < n - 2 && rpmSel > voices[i + 1].rpm) i++;
    const lo = voices[i];
    const hi = voices[i + 1];

    const t = (rpmSel - lo.rpm) / (hi.rpm - lo.rpm);
    const { a: gLo, b: gHi } = equalPowerCrossfade(t);

    const now = this._audio.now;

    for (let j = 0; j < n; j++) {
      const v = voices[j];

      let targetGain = 0;
      if (j === i) targetGain = gLo;
      else if (j === i + 1) targetGain = gHi;
      v.gain.gain.setTargetAtTime(targetGain, now, this._gainTau);

      const rate = rpm / v.rpm;
      v.src.playbackRate.setTargetAtTime(rate, now, this._rateTau);
    }
  }

  /**
   * Atualiza o banco para um RPM alvo. Deve ser chamado a cada frame.
   *
   * @param {number} rpm  RPM alvo (recomenda-se o displayRpm filtrado do motor).
   */
  update(rpm) {
    if (!this._started) return;

    const voices = this._voices;
    const n = voices.length;
    const first = voices[0].rpm;
    const last = voices[n - 1].rpm;

    // RPM usado para SELECIONAR as camadas (fixado à faixa das âncoras).
    const rpmSel = clamp(rpm, first, last);

    // Encontra o par de âncoras [i, i+1] que envolve rpmSel.
    let i = 0;
    while (i < n - 2 && rpmSel > voices[i + 1].rpm) i++;
    const lo = voices[i];
    const hi = voices[i + 1];

    // Posição do crossfade entre as duas âncoras e ganhos de potência constante.
    const t = (rpmSel - lo.rpm) / (hi.rpm - lo.rpm);
    const { a: gLo, b: gHi } = equalPowerCrossfade(t);

    const now = this._audio.now;

    for (let j = 0; j < n; j++) {
      const v = voices[j];

      // Ganho: apenas o par ativo soa; o restante vai a zero suavemente.
      let targetGain = 0;
      if (j === i) targetGain = gLo;
      else if (j === i + 1) targetGain = gHi;
      v.gain.gain.setTargetAtTime(targetGain, now, this._gainTau);

      // Pitch: cada camada é afinada para o MESMO RPM alvo. Assim as duas vozes
      // ativas compartilham o pitch (sem batimento) — só o timbre transiciona.
      // Atualizamos todas as vozes para manter a coerência quando uma entra.
      const rate = rpm / v.rpm;
      v.src.playbackRate.setTargetAtTime(rate, now, this._rateTau);
    }
  }

  /**
   * Define o ganho do barramento do banco de RPM de forma suave (volume/duck).
   * @param {number} value
   * @param {number} [tau=0.03]  Constante de tempo da transição.
   */
  setBusGain(value, tau = 0.03) {
    if (!this._busGain) return;
    this._busGain.gain.setTargetAtTime(clamp(value, 0, 4), this._audio.now, tau);
  }

  /** Ajusta o barramento de FX (usado no fade de desligamento). @private */
  _fadeFx(value, tau) {
    if (!this._fxGain) return;
    this._fxGain.gain.setTargetAtTime(clamp(value, 0, 4), this._audio.now, tau);
  }

  // ---------------------------------------------------------------------------
  // Camada do acelerador (throttle on/off) — misturada, nunca interrompe o loop
  // ---------------------------------------------------------------------------

  /**
   * Dispara o transiente do acelerador ao cruzar entre solto e pleno.
   * @param {boolean} opening  true = pisou (throttle_on), false = soltou (throttle_off).
   */
  throttleBlip(opening) {
    if (!this._started || !this.throttleLayerEnabled) return;
    const name = opening ? 'throttle_on' : 'throttle_off';
    const gain = opening ? MIX.THROTTLE_ON : MIX.THROTTLE_OFF;
    this._audio.playOneShot(name, { gain, destination: this._fxGain, fadeIn: 0.01 });
  }

  // ---------------------------------------------------------------------------
  // Rev limiter — loop sobreposto, sem cortar o áudio principal
  // ---------------------------------------------------------------------------

  /**
   * Liga/desliga a camada do rev limiter conforme o motor está cortando.
   * Ataque rápido e release um pouco mais lento suavizam o "trepidar" do corte
   * (que liga/desliga muitas vezes por segundo) numa sonoridade contínua.
   * @param {boolean} active
   */
  setLimiter(active) {
    if (!this._limiterVoice) return;
    const target = active ? MIX.LIMITER : 0;
    const tau = active ? 0.008 : 0.05; // ataque rápido, release suave
    this._limiterVoice.gain.gain.setTargetAtTime(target, this._audio.now, tau);
  }

  // ---------------------------------------------------------------------------
  // Trocas de marcha — one-shot + ducking do banco de RPM
  // ---------------------------------------------------------------------------

  /**
   * Toca o som de uma troca e aplica um leve "duck" no banco de RPM, para o som
   * da troca respirar sem que o loop principal seja cortado.
   * @param {string} sample  'gear_up' | 'gear_down_even' | 'gear_down_odd'.
   */
  playShift(sample) {
    if (!this._started || !sample) return;
    const gain = sample === 'gear_up' ? MIX.GEAR_UP : MIX.GEAR_DOWN;
    this._audio.playOneShot(sample, { gain, fadeIn: 0.005 });
    this.duck(MIX.DUCK_LEVEL, 150);
  }

  /**
   * Abaixa momentaneamente o banco de RPM e restaura em seguida.
   * @param {number} [level=0.45]   Ganho durante o duck.
   * @param {number} [holdMs=150]   Tempo abaixado antes de restaurar.
   * @param {number} [restoreTau=0.1] Suavidade da restauração.
   */
  duck(level = MIX.DUCK_LEVEL, holdMs = 150, restoreTau = 0.1) {
    if (!this._busGain) return;
    if (this._duckTimer) clearTimeout(this._duckTimer);
    this.setBusGain(level, 0.02); // abaixa rápido
    this._duckTimer = setTimeout(() => {
      this.setBusGain(1, restoreTau); // restaura suave
      this._duckTimer = null;
    }, holdMs);
  }

  // ---------------------------------------------------------------------------
  // Encerramento
  // ---------------------------------------------------------------------------

  /**
   * Para e descarta TODAS as vozes (banco + limitador) e os barramentos. Após
   * isto, um novo start() recria tudo do zero (os BUFFERS permanecem em cache —
   * nunca são redecodificados).
   */
  stop() {
    if (this._duckTimer) {
      clearTimeout(this._duckTimer);
      this._duckTimer = null;
    }

    const stopVoice = (v) => {
      if (!v) return;
      try {
        v.src.stop();
      } catch {
        /* já parado */
      }
      v.src.disconnect();
      v.gain.disconnect();
    };

    for (const v of this._voices) stopVoice(v);
    this._voices = [];

    stopVoice(this._limiterVoice);
    this._limiterVoice = null;

    if (this._busGain) {
      this._busGain.disconnect();
      this._busGain = null;
    }
    if (this._fxGain) {
      this._fxGain.disconnect();
      this._fxGain = null;
    }
    this._started = false;
  }
}
