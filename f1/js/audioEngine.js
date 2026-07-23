/**
 * audioEngine.js
 * -----------------------------------------------------------------------------
 * Camada de BAIXO NÍVEL sobre a Web Audio API.
 *
 * Responsabilidades:
 *   - Criar/gerenciar o AudioContext e o master gain.
 *   - Carregar e decodificar todos os buffers do manifesto.
 *   - Tocar one-shots (partida, troca de marcha, desligamento).
 *   - Fornecer "LoopVoice": vozes em loop com gain + playbackRate controláveis.
 *
 * A orquestração sonora (mixar RPM, marchas e limitador a partir do estado do
 * motor) fica no EngineSoundController, no fim deste arquivo.
 * -----------------------------------------------------------------------------
 */

/**
 * Uma voz em loop: um AudioBufferSourceNode reiniciável ligado a um GainNode.
 * O GainNode é persistente; o source é recriado a cada start (buffers só tocam 1x).
 */
export class LoopVoice {
    /**
     * @param {AudioContext} ctx
     * @param {AudioBuffer}  buffer
     * @param {AudioNode}    destination
     */
    constructor(ctx, buffer, destination) {
        this.ctx = ctx;
        this.buffer = buffer;
        this.gainNode = ctx.createGain();
        this.gainNode.gain.value = 0;
        this.gainNode.connect(destination);

        this.source = null;   // criado em start()
        this.rate = 1;        // playbackRate desejado
        this.playing = false;
    }

    /** Inicia o loop (cria um novo source). */
    start() {
        if (this.playing) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.loop = true;
        src.playbackRate.value = this.rate;
        src.connect(this.gainNode);
        src.start();
        this.source = src;
        this.playing = true;
    }

    /** Para o loop imediatamente. */
    stop() {
        if (!this.playing) return;
        try { this.source.stop(); } catch (_) { /* já parado */ }
        this.source.disconnect();
        this.source = null;
        this.playing = false;
    }

    /** Ajusta o volume suavemente (evita "zipper noise"). */
    setGain(value, smoothing = 0.02) {
        const now = this.ctx.currentTime;
        this.gainNode.gain.setTargetAtTime(value, now, smoothing);
    }

    /** Ajusta o pitch (playbackRate) suavemente. */
    setRate(rate, smoothing = 0.02) {
        this.rate = rate;
        if (this.source) {
            const now = this.ctx.currentTime;
            this.source.playbackRate.setTargetAtTime(rate, now, smoothing);
        }
    }

    /** Fade-out e stop (usado no desligamento). */
    fadeOutAndStop(time = 0.3) {
        if (!this.playing) return;
        const now = this.ctx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(0, now + time);
        const src = this.source;
        setTimeout(() => {
            try { src.stop(); src.disconnect(); } catch (_) { /* noop */ }
        }, time * 1000 + 50);
        this.source = null;
        this.playing = false;
    }
}

/**
 * Wrapper principal da Web Audio API.
 */
export class AudioEngine {
    constructor(config) {
        this.config = config;
        this.ctx = null;
        this.masterGain = null;
        this.buffers = new Map();   // nome lógico -> AudioBuffer
    }

    /** Cria o AudioContext (precisa de gesto do usuário) e o master gain. */
    init() {
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.config.audio.masterVolume;
        this.masterGain.connect(this.ctx.destination);
    }

    /** Retoma o contexto caso esteja suspenso (política de autoplay). */
    async resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    /**
     * Carrega e decodifica um único item do manifesto (pula se já em cache).
     * @param {string} name
     */
    async _loadEntry(name) {
        if (this.buffers.has(name)) return;
        const file = this.config.manifest[name];
        if (!file) return;
        const url = this.config.audio.basePath + file;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.arrayBuffer();
            const buffer = await this.ctx.decodeAudioData(data);
            this.buffers.set(name, buffer);
        } catch (err) {
            // Não aborta por causa de um arquivo ausente — apenas avisa.
            console.warn(`[AudioEngine] Falha ao carregar "${name}" (${url}):`, err.message);
        }
    }

    /**
     * Carrega uma lista de itens (prioridade). Itens já em cache são pulados.
     * @param {string[]} names
     * @param {(loaded:number, total:number)=>void} [onProgress]
     */
    async loadSome(names, onProgress) {
        this.init();
        let loaded = 0;
        await Promise.all(names.map(async (name) => {
            await this._loadEntry(name);
            loaded++;
            if (onProgress) onProgress(loaded, names.length);
        }));
    }

    /**
     * Carrega e decodifica todos os arquivos do manifesto (pula os já em cache).
     * @param {(loaded:number, total:number)=>void} [onProgress]
     */
    async loadAll(onProgress) {
        this.init();
        const names = Object.keys(this.config.manifest);
        let loaded = 0;
        await Promise.all(names.map(async (name) => {
            await this._loadEntry(name);
            loaded++;
            if (onProgress) onProgress(loaded, names.length);
        }));
    }

    /** @returns {AudioBuffer|undefined} */
    getBuffer(name) {
        return this.buffers.get(name);
    }

    /** Cria (mas não inicia) uma voz em loop, opcionalmente num barramento. */
    createLoop(name, destination = null) {
        const buffer = this.getBuffer(name);
        if (!buffer) return null;
        return new LoopVoice(this.ctx, buffer, destination || this.masterGain);
    }

    /** Cria um barramento de ganho ligado ao master (para agrupar vozes). */
    createBus(initialGain = 1) {
        const bus = this.ctx.createGain();
        bus.gain.value = initialGain;
        bus.connect(this.masterGain);
        return bus;
    }

    /**
     * Toca um one-shot.
     * @returns {{duration:number, source:?AudioBufferSourceNode, gain:?GainNode}}
     *          handle controlável (permite fade-out) ou vazio se ausente.
     */
    playOneShot(name, { volume = 1 } = {}) {
        const buffer = this.getBuffer(name);
        if (!buffer) return { duration: 0, source: null, gain: null };

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const g = this.ctx.createGain();
        g.gain.value = volume;
        src.connect(g).connect(this.masterGain);
        src.start();
        src.onended = () => { src.disconnect(); g.disconnect(); };
        return { duration: buffer.duration, source: src, gain: g };
    }

    /**
     * Faz fade-out e para um one-shot em andamento (ex.: a bomba de combustível).
     * Tolerante caso o som já tenha terminado sozinho.
     * @param {{source:?AudioBufferSourceNode, gain:?GainNode}} handle
     * @param {number} [seconds=0.35]
     */
    fadeOutOneShot(handle, seconds = 0.35) {
        if (!handle || !handle.source) return;
        const t = this.ctx.currentTime;
        const g = handle.gain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + seconds);
        try { handle.source.stop(t + seconds + 0.02); } catch (_) { /* já parado */ }
    }
}

/* ---------------------------------------------------------------------------
 * Utilitários matemáticos
 * ------------------------------------------------------------------------- */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * EngineSoundController
 * ---------------------------------------------------------------------------
 * Camada de ALTO NÍVEL: transforma o estado do motor (RPM, acelerador, marcha,
 * limitador) em mixagem de áudio, usando as vozes em loop do AudioEngine.
 *
 * Mantém TODAS as vozes tocando simultaneamente e apenas ajusta ganho + pitch
 * a cada frame — assim nunca há troca abrupta de sample; tudo é crossfade.
 * ------------------------------------------------------------------------- */
export class EngineSoundController {
    constructor(audioEngine, config) {
        this.audio = audioEngine;
        this.config = config;
        this.profile = config.soundProfile || 'gearLoops';

        this.rpmVoices = [];   // uma LoopVoice por layer de RPM
        this.accelVoices = []; // gear_X_acceleration (perfil gearLoops)
        this.decelVoices = []; // gear_X_deceleration (perfil gearLoops)
        this.limiterVoice = null;
        this.engineBus = null; // barramento de todas as vozes de motor (fade in/out)
        this._stopTimer = null; // timer do stop pós-shutdown (evita corrida com restart)
        this._duckTimer = null; // timer do duck da troca de marcha

        this.built = false;
    }

    /** Cria o barramento e todas as vozes em loop (sem iniciá-las ainda). */
    build() {
        const { rpmLayers, gearbox, sounds } = this.config;
        const bus = this.audio.createBus(1);
        this.engineBus = bus;

        this.rpmVoices = rpmLayers.map(layer => ({
            rpm: layer.rpm,
            voice: this.audio.createLoop(layer.name, bus),
        }));

        // Loops de marcha só existem no perfil gearLoops (F1).
        this.accelVoices = [];
        this.decelVoices = [];
        if (this.profile === 'gearLoops') {
            for (let g = 1; g <= gearbox.gearCount; g++) {
                this.accelVoices.push(this.audio.createLoop(`gear_${g}_acceleration`, bus));
                this.decelVoices.push(this.audio.createLoop(`gear_${g}_deceleration`, bus));
            }
        }

        this.limiterVoice = this.audio.createLoop(sounds.limiterLoop, bus);
        this.built = true;
    }

    /**
     * Inicia os loops. `fadeIn` faz o barramento do motor subir de 0 a 1 nesse
     * tempo (usado no crossfade de emenda com o som de partida). 0 = seco.
     * @param {number} [fadeIn=0]
     */
    startLoops(fadeIn = 0) {
        if (!this.built) this.build();
        // Cancela um stop pendente de um shutdown anterior (evita cortar o som novo).
        if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
        this.rpmVoices.forEach(l => l.voice && l.voice.start());
        this.accelVoices.forEach(v => v && v.start());
        this.decelVoices.forEach(v => v && v.start());
        if (this.limiterVoice) this.limiterVoice.start();

        const ctx = this.audio.ctx;
        const t = ctx.currentTime;
        this.engineBus.gain.cancelScheduledValues(t);
        if (fadeIn > 0) {
            this.engineBus.gain.setValueAtTime(0, t);
            this.engineBus.gain.linearRampToValueAtTime(1, t + fadeIn);
        } else {
            this.engineBus.gain.setValueAtTime(1, t); // imediato
        }
    }

    /**
     * Chave DISPLAY (power on): toca o clique da chave, aguarda uma pequena
     * pausa, escorva a bomba pelo tempo configurado e então faz o fade-out.
     * Replica exatamente o timing do projeto aud_gt3.
     */
    async powerOnSequence() {
        const {
            switchSound, primeSound, primeDelay, primeDuration, primeFade,
        } = this.config.power;

        this.audio.playOneShot(switchSound);
        await this._wait(primeDelay);

        const pump = this.audio.playOneShot(primeSound);
        await this._wait(primeDuration);
        this.audio.fadeOutOneShot(pump, primeFade); // bomba some após o tempo fixo
    }

    /** Chave DISPLAY (power off): apenas o clique da chave. */
    playPowerSwitch() {
        this.audio.playOneShot(this.config.power.switchSound);
    }

    /**
     * Sequência de partida (ignição). Toca os one-shots e revela a marcha lenta
     * SOBREPONDO o fim do último clip — sem gap de silêncio entre partida e lenta.
     * @param {() => void} [onReveal]  chamado no instante em que a lenta surge
     *                                 (o app usa para ligar o motor / flare).
     */
    async startupSequence(onReveal) {
        const seq = this.config.startupSequence;
        const { startupGap, startupCrossfade } = this.config.audio;

        // Todos os clipes, menos o último, com uma pequena pausa entre eles.
        for (let i = 0; i < seq.length - 1; i++) {
            const { duration } = this.audio.playOneShot(seq[i]);
            await this._wait(duration + startupGap);
        }

        // Último clipe (partida). Guarda o handle para cruzá-lo com a lenta.
        const last = seq[seq.length - 1];
        const handle = this.audio.playOneShot(last);
        const cf = startupCrossfade;
        const revealAt = Math.max(0, handle.duration - cf);
        await this._wait(revealAt);

        // Emenda: a lenta SOBE enquanto a partida DESCE, no mesmo instante.
        this.startLoops(cf);                       // lenta sobe em cf
        if (onReveal) onReveal();                  // motor liga
        this.audio.fadeOutOneShot(handle, cf);     // partida some em cf

        await this._wait(cf);
    }

    /** One-shot de subida de marcha (+ duck no perfil só-banco). */
    playGearUp() {
        this.audio.playOneShot(this.config.sounds.gearUp);
        this._duckIfBank();
    }

    /**
     * One-shot de redução. O som pode ser único (string) ou por paridade da
     * marcha de destino ({ even, odd }), como no GT3.
     * @param {number} newGear  marcha de destino após a redução.
     */
    playGearDown(newGear) {
        const gd = this.config.sounds.gearDown;
        const name = (typeof gd === 'string')
            ? gd
            : (newGear % 2 === 0 ? gd.even : gd.odd);
        if (name) this.audio.playOneShot(name);
        this._duckIfBank();
    }

    /**
     * Atualiza a mixagem a partir do estado do motor. Chamado a cada frame.
     * @param {{rpm:number, throttle:number, audioThrottle:number, gear:number,
     *          limiterActive:boolean}} state
     */
    update(state) {
        if (!this.built) return;
        this._mixRpmLayers(state.rpm);
        // Perfil 'gearLoops' (F1) sobrepõe loops de marcha. Os demais (GT3) são
        // SÓ o banco de RPM — como no projeto original, sem camada de throttle.
        if (this.profile === 'gearLoops') this._mixGearLayers(state);
        this._mixLimiter(state);
    }

    /** Desligamento: toca o shutdown e faz o fade-out do barramento do motor. */
    shutdown() {
        this.audio.playOneShot(this.config.sounds.shutdown);
        if (this._duckTimer) { clearTimeout(this._duckTimer); this._duckTimer = null; }

        const fade = this.config.audio.shutdownFade;
        if (this.engineBus) {
            const ctx = this.audio.ctx;
            const t = ctx.currentTime;
            this.engineBus.gain.cancelScheduledValues(t);
            this.engineBus.gain.setValueAtTime(this.engineBus.gain.value, t);
            this.engineBus.gain.linearRampToValueAtTime(0, t + fade);
        }
        // Para as vozes após o fade (sources são de uso único).
        this._stopTimer = setTimeout(() => {
            this._forEachVoice(v => v.stop());
            this._stopTimer = null;
        }, fade * 1000 + 60);
    }

    /* ---------------------- mixagem interna ---------------------- */

    /**
     * Crossfade + pitch entre os dois layers de RPM que cercam o RPM atual.
     *
     * NÃO clampa o pitch: as duas vozes ativas são afinadas para o MESMO RPM
     * (rpm/layerRpm), então soam na mesma altura — sem batimento. Clampar
     * desafinaria uma em relação à outra (o que deixava o GT3 horrível nos vãos).
     * O pitch é atualizado em TODAS as vozes para não haver glitch quando uma
     * entra na mistura.
     */
    _mixRpmLayers(rpm) {
        const { pitchRange, crossfadeSmoothing, volumes } = this.config.audio;
        const layers = this.rpmVoices;
        const master = volumes.rpmLayers;

        // Encontra o par [i, i+1] que envolve o RPM atual.
        let i = 0;
        while (i < layers.length - 2 && rpm > layers[i + 1].rpm) i++;

        const low = layers[i];
        const high = layers[i + 1];
        const span = high.rpm - low.rpm;
        const frac = clamp((rpm - low.rpm) / span, 0, 1);

        // Crossfade de potência constante (evita queda de volume no meio).
        const gLow = Math.cos(frac * Math.PI / 2);
        const gHigh = Math.sin(frac * Math.PI / 2);

        layers.forEach((l, idx) => {
            if (!l.voice) return;
            let gain = 0;
            if (idx === i) gain = gLow;
            else if (idx === i + 1) gain = gHigh;
            l.voice.setGain(gain * master, crossfadeSmoothing);

            if (idx === i || idx === i + 1) {
                const rate = clamp(rpm / l.rpm, pitchRange.min, pitchRange.max);
                l.voice.setRate(rate, crossfadeSmoothing);
            }
        });
    }

    /**
     * Mixa os loops de aceleração/desaceleração da marcha atual.
     * Acelerando -> gear_X_acceleration; soltando -> gear_X_deceleration.
     * As demais marchas ficam em silêncio.
     *
     * As camadas entram gradualmente só ACIMA da lenta (engagement): na marcha
     * lenta ficam mudas, evitando o sample de desaceleração repetindo no idle.
     */
    _mixGearLayers(state) {
        const { volumes, crossfadeSmoothing, gearEngageRPM } = this.config.audio;
        const { idleRPM } = this.config.engine;
        const g = state.gear - 1; // índice base 0

        // 0 na lenta -> 1 quando o motor sobe gearEngageRPM acima da lenta.
        const engage = clamp((state.rpm - idleRPM) / gearEngageRPM, 0, 1);
        // Usa o acelerador EFETIVO (inclui o flare) para o balanço accel/decel.
        const th = state.audioThrottle;

        this.accelVoices.forEach((v, idx) => {
            if (!v) return;
            const gain = (idx === g) ? th * engage * volumes.gearAccel : 0;
            v.setGain(gain, crossfadeSmoothing);
        });

        this.decelVoices.forEach((v, idx) => {
            if (!v) return;
            const gain = (idx === g) ? (1 - th) * engage * volumes.gearDecel : 0;
            v.setGain(gain, crossfadeSmoothing);
        });
    }

    /** Aplica o duck da troca só no perfil só-banco (GT3), como no original. */
    _duckIfBank() {
        if (this.profile === 'gearLoops') return; // F1 não usa duck
        this._duck(this.config.audio.duckLevel ?? 0.45, this.config.audio.duckTime ?? 0.15);
    }

    /**
     * Abaixa o banco de RPM por um instante e restaura (para o som da troca
     * "respirar" sem cortar o loop principal).
     */
    _duck(level, seconds) {
        if (!this.engineBus) return;
        const g = this.engineBus.gain;
        const t = this.audio.ctx.currentTime;
        if (this._duckTimer) clearTimeout(this._duckTimer);
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(level, t + 0.03);
        this._duckTimer = setTimeout(() => {
            const t2 = this.audio.ctx.currentTime;
            g.cancelScheduledValues(t2);
            g.setValueAtTime(g.value, t2);
            g.linearRampToValueAtTime(1, t2 + 0.12);
            this._duckTimer = null;
        }, seconds * 1000);
    }

    /** Liga o loop do limitador apenas quando no limite e com acelerador. */
    _mixLimiter(state) {
        if (!this.limiterVoice) return;
        const { volumes, crossfadeTime } = this.config.audio;
        const on = state.limiterActive && state.throttle > 0.5;
        this.limiterVoice.setGain(on ? volumes.limiter : 0, crossfadeTime);
    }

    /* ---------------------- helpers ---------------------- */

    _forEachVoice(fn) {
        this.rpmVoices.forEach(l => l.voice && fn(l.voice));
        this.accelVoices.forEach(v => v && fn(v));
        this.decelVoices.forEach(v => v && fn(v));
        if (this.limiterVoice) fn(this.limiterVoice);
    }

    _wait(seconds) {
        return new Promise(res => setTimeout(res, seconds * 1000));
    }
}
