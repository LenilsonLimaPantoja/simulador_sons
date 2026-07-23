/**
 * engine.js
 * -----------------------------------------------------------------------------
 * Modelo FÍSICO do motor (apenas números — sem áudio, sem DOM).
 *
 * Responsabilidade única: simular a rotação do motor como uma INÉRCIA ROTATIVA.
 * O RPM é sempre o resultado da integração de um torque líquido no tempo; ele
 * NUNCA é atribuído diretamente. Não existe "rpm += 100" em lugar algum — só
 * torque -> aceleração angular -> integração.
 *
 * Torque líquido = torque do motor (throttle × curva de torque)
 *                + governador de marcha lenta
 *                − atrito interno / freio-motor
 *                − carga externa (transmissão; chega na Etapa 4)
 *
 * Recursos exigidos e onde vivem:
 *   - Idle .............. governador proporcional que estabiliza em IDLE_RPM.
 *   - Inércia ........... integração netTorque / inertia => rpmDot.
 *   - Torque ............ curva de torque normalizada por RPM.
 *   - Throttle .......... entrada suavizada (atraso do atuador) => resposta progressiva.
 *   - Engine brake ...... atrito viscoso que cresce com o RPM ao soltar o acelerador.
 *   - Rev limiter ....... corte de combustível com histerese acima de LIMITER_RPM.
 *   - RPM smoothing ..... a própria integração é suave; expomos também um RPM filtrado.
 *
 * As camadas superiores (vehicle/audio/dashboard) apenas LEEM o estado; nunca
 * o escrevem. Isso mantém o motor como fonte única de verdade da rotação.
 * -----------------------------------------------------------------------------
 */

import { clamp, expApproach } from './utils.js';

/**
 * Parâmetros do motor GT3. Congelados: são dados de calibração, não estado.
 * @type {Readonly<object>}
 */
export const ENGINE_CONFIG = Object.freeze({
  IDLE_RPM: 1164,
  MAX_RPM: 8500,     // teto absoluto (clamp de segurança)
  REDLINE_RPM: 8200, // início da zona vermelha (indicador de troca)
  LIMITER_RPM: 8500, // corte do rev limiter

  // Faixa (RPM) do limitador SUAVE: dentro desta janela logo abaixo do corte,
  // o torque motriz é reduzido progressivamente até zero, segurando o giro de
  // forma ESTÁVEL no limite (sem "cair e voltar"). Menor = segura mais colado.
  LIMITER_BAND: 120,

  // --- Coeficientes de dinâmica (unidades sintonizadas: torque em rpm/s²·inertia) ---
  // Inércia do virabrequim. Calibrada para que, em NEUTRO (sem carga), uma
  // "triscada" no acelerador dê uma subida controlada (não um estouro até o
  // limitador). Valor maior = motor mais "pesado"/dócil ao acelerar.
  INERTIA: 1.6,

  // Escala do torque motriz a acelerador pleno (rpm/s no pico da curva).
  TORQUE_SCALE: 11000,

  // Atrito interno = ATRITO ESTÁTICO + ATRITO VISCOSO × rpm.
  // O termo viscoso é o principal responsável pelo freio-motor.
  FRICTION_STATIC: 300,
  FRICTION_VISCOUS: 0.5,

  // Governador de marcha lenta (controle proporcional do "ECU").
  IDLE_KP: 6.0,        // rigidez do governador
  IDLE_GOV_BAND: 700,  // faixa acima do idle onde o governador ainda atua

  // Constantes de tempo dos filtros de 1ª ordem (segundos).
  // THROTTLE_SMOOTH mais alto = um toque curto entrega só uma fração do
  // acelerador (evita que uma "triscada" mande o giro lá pra cima). Não deixa a
  // arrancada lenta, pois numa arrancada o acelerador fica pressionado.
  THROTTLE_SMOOTH: 0.18, // atraso do atuador do acelerador (resposta progressiva)
  DISPLAY_SMOOTH: 0.04,  // suavização extra do RPM exibido/usado pelo áudio

  // Flare de partida: ao ligar, um "afogador" temporário sobe o giro a ~2000 e
  // decai até a marcha lenta — mascara a transição do starter para o idle e soa
  // como um motor pegando. THROTTLE = intensidade inicial; DECAY = suavidade.
  STARTUP_FLARE_THROTTLE: 1.0,
  STARTUP_FLARE_DECAY: 0.55,

  // Abaixo deste RPM o motor "morre" quando não está mais em funcionamento.
  STALL_RPM: 200,

  // Passo de integração máximo aceito (segundos). Protege contra saltos de dt
  // (ex.: aba em segundo plano) que desestabilizariam a integração.
  MAX_DT: 0.05,
});

/**
 * Pontos de controle da curva de torque normalizada (rpm -> torque 0..1).
 * Perfil típico de GT3 naturalmente aspirado: torque cheio e plano no meio,
 * com leve queda perto do corte. Interpolação linear entre os pontos.
 * @type {ReadonlyArray<[number, number]>}
 */
const TORQUE_CURVE = Object.freeze([
  [1000, 0.55],
  [2000, 0.70],
  [3000, 0.80],
  [4000, 0.88],
  [5000, 0.95],
  [6000, 1.00],
  [7000, 0.97],
  [8000, 0.88],
  [8500, 0.80],
]);

/**
 * Avalia a curva de torque em um dado RPM (interpolação linear, com saturação
 * nas extremidades).
 * @param {number} rpm
 * @returns {number} Torque normalizado em [0, 1].
 */
function torqueCurveAt(rpm) {
  const pts = TORQUE_CURVE;
  if (rpm <= pts[0][0]) return pts[0][1];
  if (rpm >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];

  for (let i = 0; i < pts.length - 1; i++) {
    const [r0, t0] = pts[i];
    const [r1, t1] = pts[i + 1];
    if (rpm >= r0 && rpm <= r1) {
      const f = (rpm - r0) / (r1 - r0);
      return t0 + (t1 - t0) * f;
    }
  }
  return pts[pts.length - 1][1]; // inalcançável, mas explícito
}

export class Engine {
  constructor(config = ENGINE_CONFIG) {
    this.cfg = config;

    /** RPM real (resultado da integração). @type {number} */
    this._rpm = 0;

    /** RPM filtrado para exibição/áudio (evita micro-jitter). @type {number} */
    this._displayRpm = 0;

    /** Alvo do acelerador em [0, 1] definido pelos controles. @type {number} */
    this._throttleTarget = 0;

    /** Acelerador suavizado (atraso do atuador). @type {number} */
    this._throttle = 0;

    /** Motor em funcionamento? Controla se há combustão. @type {boolean} */
    this._running = false;

    /** Limitador atuando neste instante (para o som)? @type {boolean} */
    this._limiterActive = false;

    /** "Afogador" de partida: acelerador extra que decai após ligar. @type {number} */
    this._startThrottle = 0;
  }

  // ---------------------------------------------------------------------------
  // Entradas (escritas pelos controles / sequências de ignição)
  // ---------------------------------------------------------------------------

  /**
   * Define o acelerador alvo. O valor efetivo é suavizado internamente, então
   * a resposta é sempre progressiva — nunca um degrau.
   * @param {number} value  0 (solto) .. 1 (pleno).
   */
  setThrottle(value) {
    this._throttleTarget = clamp(value, 0, 1);
  }

  /**
   * Liga a combustão. Não faz o RPM "pular": apenas passa a haver torque motriz
   * e governador. A subida a partir de 0/idle acontece pela integração. A
   * sequência sonora do starter é responsabilidade da Etapa 5.
   */
  start() {
    this._running = true;
    // Dispara o flare de partida (sobe o giro e assenta na marcha lenta).
    this._startThrottle = this.cfg.STARTUP_FLARE_THROTTLE;
  }

  /**
   * Corta a combustão. O RPM decai naturalmente pelo atrito até parar. O som de
   * engine_off é orquestrado por camadas superiores.
   */
  stop() {
    this._running = false;
    this._startThrottle = 0;
  }

  /**
   * Reset imediato para o estado desligado/zerado (corte de energia do painel).
   * Zera RPM, acelerador e flags — usado ao desligar a chave DISPLAY.
   */
  reset() {
    this._running = false;
    this._rpm = 0;
    this._displayRpm = 0;
    this._throttle = 0;
    this._throttleTarget = 0;
    this._startThrottle = 0;
    this._limiterActive = false;
  }

  /**
   * Sincroniza o RPM ao engate da embreagem (evento físico discreto).
   *
   * Este é o ÚNICO ponto em que o RPM é reposicionado de fora — e representa a
   * embreagem travando o motor à velocidade das rodas ao trocar de marcha
   * (numa caixa sequencial). NÃO é um "rpm += x" arbitrário: é a aplicação de
   * uma restrição cinemática num instante discreto. Entre trocas, o RPM segue
   * exclusivamente pela integração de torque.
   *
   * @param {number} targetRpm  RPM imposto pela velocidade × relação da marcha.
   */
  clutchSync(targetRpm) {
    this._rpm = clamp(targetRpm, 0, this.cfg.MAX_RPM);
    this._displayRpm = this._rpm; // pitch acompanha imediatamente (o duck da troca mascara)
  }

  // ---------------------------------------------------------------------------
  // Passo de simulação
  // ---------------------------------------------------------------------------

  /**
   * Avança a simulação em `dt` segundos.
   *
   * @param {number} dt              Delta de tempo do frame (segundos).
   * @param {number} [externalLoad=0]  Torque de carga da transmissão (rpm/s).
   *                                    0 = motor livre (neutro).
   * @param {number} [addedInertia=0]  Inércia extra acoplada ao virabrequim
   *                                    (massa do veículo refletida pela marcha).
   *                                    0 = neutro/embreagem aberta. Quanto maior,
   *                                    mais devagar o motor sobe de giro — é o que
   *                                    faz a 6ª "pesar" e a 1ª "estourar".
   */
  update(dt, externalLoad = 0, addedInertia = 0) {
    const cfg = this.cfg;

    // Protege a integração contra saltos de dt.
    dt = clamp(dt, 0, cfg.MAX_DT);
    if (dt <= 0) return;

    // 1) Suaviza o acelerador (atraso do atuador => resposta progressiva).
    this._throttle = expApproach(this._throttle, this._throttleTarget, cfg.THROTTLE_SMOOTH, dt);

    // Flare de partida: decai a zero após ligar. Enquanto ativo, funciona como
    // um piso de acelerador que sobe o giro e assenta na marcha lenta.
    this._startThrottle = expApproach(this._startThrottle, 0, cfg.STARTUP_FLARE_DECAY, dt);
    const effThrottle = Math.max(this._throttle, this._startThrottle);

    // 2) Torque motriz (combustão). Zero quando o motor está desligado.
    let driveTorque = this._running
      ? effThrottle * torqueCurveAt(this._rpm) * cfg.TORQUE_SCALE
      : 0;

    // 3) Rev limiter SUAVE (soft-cut). Em vez de um corte total com histerese
    //    (que faz o giro "cair e voltar"), reduzimos progressivamente o torque
    //    numa faixa logo abaixo do corte. Assim o motor ESTABILIZA colado no
    //    limite enquanto o acelerador está pleno — sem trepidar no RPM. A
    //    sonoridade do corte vem de rev_limiter.wav (camada separada).
    const limiterFactor = clamp((cfg.LIMITER_RPM - this._rpm) / cfg.LIMITER_BAND, 0, 1);
    driveTorque *= limiterFactor;
    // "Limitando" (para o som) quando o torque já está bem reduzido no topo.
    this._limiterActive = this._running && limiterFactor < 0.9;

    // 4) Governador de marcha lenta. Feedforward (compensa o atrito no idle) +
    //    termo proporcional que estabiliza exatamente em IDLE_RPM. Sua
    //    autoridade some conforme o RPM sobe (não interfere em alta rotação).
    let governorTorque = 0;
    if (this._running) {
      const frictionAtIdle = cfg.FRICTION_STATIC + cfg.FRICTION_VISCOUS * cfg.IDLE_RPM;
      const proportional = cfg.IDLE_KP * (cfg.IDLE_RPM - this._rpm);
      const raw = frictionAtIdle + proportional;

      // Fade da autoridade do governador: 1 no idle, 0 em (idle + banda).
      const fade = clamp(1 - (this._rpm - cfg.IDLE_RPM) / cfg.IDLE_GOV_BAND, 0, 1);
      governorTorque = Math.max(0, raw) * fade;
    }

    // 5) Atrito interno / freio-motor: sempre se opõe à rotação.
    const frictionTorque = cfg.FRICTION_STATIC + cfg.FRICTION_VISCOUS * this._rpm;

    // 6) Torque líquido e integração (ÚNICO ponto onde o RPM evolui no tempo).
    //    A inércia efetiva soma a do motor com a do veículo refletida pela marcha.
    const netTorque = driveTorque + governorTorque - frictionTorque - externalLoad;
    const rpmDot = netTorque / (cfg.INERTIA + addedInertia);
    this._rpm += rpmDot * dt;

    // 7) Limites físicos do eixo.
    this._rpm = clamp(this._rpm, 0, cfg.MAX_RPM);

    // 8) Morte do motor: se desligado e já quase parado, zera para não "tremer".
    if (!this._running && this._rpm < cfg.STALL_RPM) {
      this._rpm = expApproach(this._rpm, 0, 0.15, dt);
    }

    // 9) RPM filtrado para consumo externo (áudio/painel).
    this._displayRpm = expApproach(this._displayRpm, this._rpm, cfg.DISPLAY_SMOOTH, dt);
  }

  // ---------------------------------------------------------------------------
  // Estado (somente leitura para as camadas superiores)
  // ---------------------------------------------------------------------------

  /** @returns {number} RPM físico bruto. */
  get rpm() {
    return this._rpm;
  }

  /** @returns {number} RPM filtrado (recomendado para pitch de áudio e painel). */
  get displayRpm() {
    return this._displayRpm;
  }

  /** @returns {number} Acelerador efetivo suavizado [0, 1]. */
  get throttle() {
    return this._throttle;
  }

  /** @returns {boolean} Motor em funcionamento. */
  get isRunning() {
    return this._running;
  }

  /** @returns {boolean} Limitador atuando neste instante (giro colado no corte). */
  get isLimiting() {
    return this._limiterActive;
  }

  /** @returns {boolean} RPM na zona vermelha (>= redline). */
  get isAtRedline() {
    return this._rpm >= this.cfg.REDLINE_RPM;
  }

  /**
   * RPM normalizado em [0, 1] entre idle e redline. Útil para LEDs e para
   * derivar mixes de áculo/áudio dependentes de rotação.
   * @returns {number}
   */
  get normalized() {
    const { IDLE_RPM, REDLINE_RPM } = this.cfg;
    return clamp((this._displayRpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM), 0, 1);
  }
}
