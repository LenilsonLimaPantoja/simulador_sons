/**
 * vehicle.js
 * -----------------------------------------------------------------------------
 * Orquestrador do simulador: a classe Vehicle COMPÕE todos os subsistemas
 * (motor físico, câmbio, som do motor, painel e controles), aplica a DINÂMICA
 * ACOPLADA do drivetrain e roda o laço de simulação.
 *
 * Responsabilidade única: coordenação. Vehicle não reimplementa física de
 * motor, cinemática de câmbio nem grafo de áudio — ele conecta esses módulos
 * (injetados via construtor) e resolve o que só existe na FRONTEIRA entre eles.
 *
 * Modelo de embreagem em TRÊS REGIMES (por marcha, a cada frame):
 *   1. NEUTRO ......... motor livre; o carro desliza e o freio o desacelera.
 *   2. PATINANDO ...... velocidade abaixo da "velocidade de marcha lenta" da
 *                       marcha (arrancada da imobilidade ou quase-parada): a
 *                       embreagem escorrega, o motor fica próximo do idle e a
 *                       velocidade evolui de forma independente. É o que
 *                       permite ARRANCAR suave e FREAR até parar sem afogar.
 *   3. ACOPLADO ....... regime normal de condução: embreagem travada, a
 *                       velocidade deriva do RPM (com a inércia refletida
 *                       dando "peso" por marcha) e o freio reduz ambos juntos.
 *
 * Recursos desta versão: FREIO (controls.brake) e CÂMBIO AUTOMÁTICO (auto-shift
 * com histerese e tempo de espera). Toda troca passa por _shift(), que
 * sincroniza a embreagem e dispara o som + duck.
 * -----------------------------------------------------------------------------
 */

import { clamp } from './utils.js';
import { Gearbox } from './gearbox.js';

/**
 * Constantes da dinâmica (unidades sintonizadas por simulação headless).
 * @type {Readonly<object>}
 */
export const VEHICLE_DYNAMICS = Object.freeze({
  // Inércia refletida do câmbio -> inércia adicional abstrata do motor.
  INERTIA_SCALE: 1.05,

  // Resistência ao movimento no regime ACOPLADO (reflexo no virabrequim):
  // rolagem constante + arrasto em v², dividida pela relação total.
  ROAD_ROLL: 700,
  ROAD_DRAG: 0.9,

  // Desaceleração máxima do FREIO (m/s²) a freio pleno (~1,4 g, freios de corrida).
  BRAKE_DECEL: 14,

  // Resistência de rolagem/arrasto expressa em m/s² (regimes patinando/neutro).
  COAST_DECEL: 0.5,     // rolagem base
  AERO_DECEL: 0.0009,   // arrasto ~ v² (m/s² por (m/s)²)

  // --- Embreagem que patina (arrancada e quase-parada) ---
  // O torque da embreagem é proporcional ao escorregamento (motor − roda),
  // limitado pela CAPACIDADE, que cresce com o ENGATE (a embreagem "fecha" ao
  // longo de CLUTCH_ENGAGE_TIME quando há acelerador). Esse torque FREIA o motor
  // e ACELERA o carro ao mesmo tempo: as rotações CONVERGEM gradualmente e a
  // trava ocorre com escorregamento já pequeno — SEM salto de RPM (foi isto que
  // causava o "voltar pro início" da 1ª). Calibrado por simulação: flare modesto
  // (~1300 rpm), trava em ~1,1 s, arrancada 0-50 ~2,4 s.
  CLUTCH_STIFFNESS: 60,          // torque (rpm/s) por rpm de escorregamento
  // Capacidade calibrada para que, ao engatar COM GIRO (acelerando em neutro e
  // trocando), a embreagem NÃO arraste o motor para baixo — ele segura o giro
  // e o carro alcança (evita o "volta e bloqueia o acelerador"). Ainda baixa o
  // suficiente para não afogar numa largada da imobilidade.
  CLUTCH_CAPACITY: 6000,         // torque máximo transmitível com a embreagem fechada
  CLUTCH_ENGAGE_TIME: 0.55,      // tempo (s) para a embreagem fechar totalmente
  CLUTCH_DRIVE_GAIN: 9e-5,       // torque da embreagem -> aceleração do carro (× relação total)
  CLUTCH_LOCK_SLIP: 100,         // escorregamento (rpm) abaixo do qual a embreagem trava

  // Câmbio automático.
  AUTO_UP_RPM: 7900,    // sobe marcha esticando perto da zona vermelha
  AUTO_DOWN_RPM: 3200,  // desce marcha ao cair disto
  AUTO_SHIFT_COOLDOWN: 0.45, // espera mínima entre trocas automáticas (s)

  // Duração (s) do flash do controle de tração (TC) ao trocar acelerando.
  TC_FLASH: 0.6,

  // Passo máximo de simulação (s).
  MAX_DT: 0.05,
});

export class Vehicle {
  /**
   * @param {object} deps
   * @param {import('./engine.js').Engine}       deps.engine
   * @param {import('./gearbox.js').Gearbox}     deps.gearbox
   * @param {import('./audioEngine.js').EngineSound} deps.engineSound
   * @param {import('./dashboard.js').Dashboard} deps.dashboard
   * @param {import('./controls.js').Controls}   deps.controls
   */
  constructor({ engine, gearbox, engineSound, dashboard, controls }) {
    this._engine = engine;
    this._gearbox = gearbox;
    this._sound = engineSound;
    this._dash = dashboard;
    this._controls = controls;

    /** Velocidade do veículo (m/s) — estado de momento do carro. @type {number} */
    this._speed = 0;

    /**
     * Embreagem travada? Quando true, motor e rodas giram juntos (regime
     * acoplado). Quando false em marcha, a embreagem patina (arrancada/parada).
     * @type {boolean}
     */
    this._clutchLocked = false;

    /** Engate da embreagem [0..1] no regime patinando (0 = aberta, 1 = fechada). */
    this._clutchEngage = 0;

    /** Câmbio automático ligado? Começa LIGADO por padrão. @type {boolean} */
    this._auto = true;

    /** Tempo restante de espera entre trocas automáticas (s). @type {number} */
    this._autoCooldown = 0;

    /** Tempo restante do flash do TC (controle de tração) (s). @type {number} */
    this._tcTimer = 0;

    /** Trava contra sequências de ignição/desligamento sobrepostas. */
    this._busy = false;

    this._rafId = null;
    this._lastTime = 0;
    this._loop = this._loop.bind(this);

    /** Callback opcional para a interface refletir o estado do automático. */
    this.onAutoChange = null;

    /** Callback opcional: motor ligou (true) / desligou (false). */
    this.onRunningChange = null;
  }

  /** Dispara o callback de estado do motor (se houver). @private */
  _emitRunning(running) {
    if (typeof this.onRunningChange === 'function') this.onRunningChange(running);
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  start() {
    this._wireControls();
    this._controls.attach();
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._loop);
    // Sem ignição automática: o motor liga pelo botão LIGA/DESLIGA. O painel
    // roda o laço mostrando o estado "desligado" (N, 0, motor parado).
  }

  destroy() {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this._controls.detach();
    if (this._sound.isStarted) this._sound.stop();
  }

  async ignite() {
    if (this._busy || this._engine.isRunning) return;
    this._busy = true;
    this._sound.start();
    // Combustão IMEDIATA: o RPM (com o flare de partida) sobe desde o início,
    // audível já sob o starter. A sequência de som revela o banco logo de cara.
    this._engine.start();
    await this._sound.ignite();
    this._emitRunning(true); // libera pedais/marchas após a partida (como no F1)
    this._busy = false;
  }

  /**
   * Corte de energia (chave DISPLAY desligada): toca o engine_off se o motor
   * estava ligado e ZERA imediatamente os valores (velocidade e RPM).
   */
  powerDown() {
    if (this._engine.isRunning) {
      this._engine.setThrottle(0);
      this._sound.shutdown().then(() => this._sound.stop());
    }
    this._engine.reset();
    this._gearbox.toNeutral();
    this._speed = 0;
    this._clutchLocked = false;
    this._clutchEngage = 0;
    this._emitRunning(false);
  }

  async shutdown() {
    if (this._busy || !this._engine.isRunning) return;
    this._busy = true;
    this._engine.setThrottle(0);
    this._engine.stop();
    this._emitRunning(false); // trava pedais/marchas ao desligar o motor
    this._gearbox.toNeutral();
    this._clutchLocked = false;
    this._clutchEngage = 0;
    await this._sound.shutdown();
    this._sound.stop();
    this._busy = false;
  }

  // ---------------------------------------------------------------------------
  // Câmbio automático
  // ---------------------------------------------------------------------------

  /** @returns {boolean} */
  get isAuto() {
    return this._auto;
  }

  /**
   * Liga/desliga o câmbio automático. Ao ligar em ponto morto, engata a 1ª.
   * @param {boolean} [value]  Se omitido, alterna.
   */
  setAuto(value = !this._auto) {
    this._auto = value;
    if (this._auto && this._gearbox.isNeutral) this._shift('up'); // N -> 1ª
    if (typeof this.onAutoChange === 'function') this.onAutoChange(this._auto);
  }

  /** Alterna o câmbio automático. */
  toggleAuto() {
    this.setAuto(!this._auto);
  }

  /**
   * Lógica de troca automática: sobe perto do corte enquanto acelera; desce ao
   * cair de giro. Histerese + tempo de espera evitam "caça de marcha".
   * @param {number} dt
   * @private
   */
  _autoShift(dt) {
    if (!this._auto || !this._engine.isRunning) return; // só com o motor ligado
    this._autoCooldown = Math.max(0, this._autoCooldown - dt);
    if (this._autoCooldown > 0 || this._busy) return;

    const rpm = this._engine.rpm;
    const gb = this._gearbox;
    const cfg = VEHICLE_DYNAMICS;
    const throttle = this._controls.throttle;

    // Engata a 1ª se estiver em neutro e houver intenção de andar.
    if (gb.isNeutral) {
      if (throttle > 0.05) this._doAutoShift('up');
      return;
    }

    // Sobe marcha perto do corte, se acelerando e não na última.
    if (throttle > 0.2 && !gb.isTopGear && rpm >= cfg.AUTO_UP_RPM) {
      this._doAutoShift('up');
      return;
    }

    // Desce marcha ao cair de giro (mantém o motor na faixa útil).
    if (gb.gear > 1 && rpm <= cfg.AUTO_DOWN_RPM) {
      this._doAutoShift('down');
    }
  }

  /**
   * Executa uma troca automática e arma o tempo de espera.
   * @param {'up'|'down'} dir
   * @private
   */
  _doAutoShift(dir) {
    const r = this._shift(dir);
    if (r) this._autoCooldown = VEHICLE_DYNAMICS.AUTO_SHIFT_COOLDOWN;
  }

  // ---------------------------------------------------------------------------
  // Controles
  // ---------------------------------------------------------------------------

  /** @private */
  _wireControls() {
    this._controls
      .on('throttleChange', (open) => this._sound.throttleBlip(open))
      .on('shiftUp', () => this._shift('up'))
      .on('shiftDown', () => this._shift('down'))
      .on('ignition', () => (this._engine.isRunning ? this.shutdown() : this.ignite()))
      .on('toggleAuto', () => this.toggleAuto());
  }

  /**
   * Executa uma troca de marcha com sincronização de embreagem.
   * @param {'up'|'down'} direction
   * @returns {boolean} true se houve troca.
   * @private
   */
  _shift(direction) {
    const speedBefore = this._speed;
    const result = direction === 'up' ? this._gearbox.shiftUp() : this._gearbox.shiftDown();
    if (!result.changed) return false;

    if (this._gearbox.isNeutral) {
      this._clutchLocked = false;
      this._clutchEngage = 0;
    } else {
      const idleSpeed = this._gearbox.speedFromRpm(this._engine.cfg.IDLE_RPM, this._gearbox.gear);
      if (speedBefore >= idleSpeed) {
        // Carro já rodando: troca com embreagem travada — casa o RPM à
        // velocidade na nova marcha (rev-matching, sem salto relativo ao carro).
        this._engine.clutchSync(this._gearbox.rpmFromSpeed(speedBefore, this._gearbox.gear));
        this._clutchLocked = true;
        this._clutchEngage = 1;
      } else {
        // Engatando de baixa velocidade/parado: NÃO derruba o giro. Deixa a
        // embreagem PATINAR a partir do RPM atual (dump de embreagem com giro),
        // convergindo suavemente. É isto que evita a queda abrupta para o idle.
        this._clutchLocked = false;
      }
    }

    this._sound.playShift(result.sample);

    // Controle de tração: dispara ao trocar de marcha com o pé no acelerador.
    if (this._controls.throttle > 0.1) this._tcTimer = VEHICLE_DYNAMICS.TC_FLASH;

    return true;
  }

  // ---------------------------------------------------------------------------
  // Laço de simulação
  // ---------------------------------------------------------------------------

  /** @private */
  _loop(nowMs) {
    const dt = (nowMs - this._lastTime) / 1000;
    this._lastTime = nowMs;
    this._step(dt);
    this._rafId = requestAnimationFrame(this._loop);
  }

  /**
   * Um passo de simulação: entrada -> automático -> dinâmica -> som -> painel.
   * @param {number} dt
   * @private
   */
  _step(dt) {
    dt = clamp(dt, 0, VEHICLE_DYNAMICS.MAX_DT);

    const engine = this._engine;
    const gearbox = this._gearbox;
    const controls = this._controls;

    // 1) Entrada -> acelerador; câmbio automático avalia trocas.
    engine.setThrottle(controls.throttle);
    this._autoShift(dt);
    if (this._tcTimer > 0) this._tcTimer = Math.max(0, this._tcTimer - dt);

    // 2) Dinâmica por regime (neutro / embreagem travada / patinando).
    if (gearbox.isNeutral) {
      this._clutchLocked = false;
      this._clutchEngage = 0;
      this._stepNeutral(dt, engine, controls);
    } else if (this._clutchLocked) {
      this._stepCoupled(dt, engine, gearbox, controls);
    } else {
      this._stepSlipping(dt, engine, gearbox, controls);
    }

    // 3) Som: banco de RPM (pitch filtrado) + estado do limitador.
    this._sound.update(engine.displayRpm);
    this._sound.setLimiter(engine.isLimiting);

    // 4) Painel.
    this._dash.update({
      rpm: engine.displayRpm,
      speedKmh: Gearbox.toKmh(this._speed),
      gear: gearbox.gear,
      atRedline: engine.isAtRedline,
      limiting: engine.isLimiting,
      braking: controls.brake > 0.01,
      tc: this._tcTimer > 0,
    });
  }

  /**
   * Regime NEUTRO: motor livre; o carro desliza e o freio o desacelera.
   * @private
   */
  _stepNeutral(dt, engine, controls) {
    engine.update(dt, 0, 0);
    this._speed = this._integrateFreeSpeed(this._speed, dt, controls.brake);
  }

  /**
   * Regime PATINANDO: a embreagem escorrega (arrancada ou quase-parada).
   *
   * O torque da embreagem é proporcional ao escorregamento (motor − roda). Esse
   * MESMO torque:
   *   - FREIA o motor (entra como carga na integração), evitando que ele
   *     dispare para o limitador enquanto o carro ainda está lento;
   *   - ACELERA o carro (transmitido pela relação da marcha).
   * Como os dois lados são puxados um para o outro, as rotações CONVERGEM e a
   * trava (lock) acontece quando o escorregamento fica pequeno — SEM salto de
   * RPM. É isto que elimina o "voltar pro início" da 1ª.
   * @private
   */
  _stepSlipping(dt, engine, gearbox, controls) {
    const cfg = VEHICLE_DYNAMICS;
    const gear = gearbox.gear;
    const idleSpeed = gearbox.speedFromRpm(engine.cfg.IDLE_RPM, gear);

    // Engate fecha ao longo de CLUTCH_ENGAGE_TIME quando há acelerador; abre ao
    // soltar (permite declutch para parar sem afogar).
    const wantEngage = controls.throttle > 0.02 ? 1 : 0;
    const rate = dt / cfg.CLUTCH_ENGAGE_TIME;
    this._clutchEngage = clamp(this._clutchEngage + (wantEngage - this._clutchEngage >= 0 ? rate : -rate), 0, 1);

    const wheelRpm = gearbox.rpmFromSpeed(this._speed, gear);
    const slip = engine.rpm - wheelRpm;

    // Torque transmitido: mola proporcional ao escorregamento, limitada pela
    // capacidade atual (cresce com o engate).
    const capacity = this._clutchEngage * cfg.CLUTCH_CAPACITY;
    const clutchTorque = clamp(cfg.CLUTCH_STIFFNESS * slip, -capacity, capacity);

    // Motor: sente o torque da embreagem como carga (reação).
    engine.update(dt, clutchTorque, 0);

    // Carro: acelerado pelo torque da embreagem (× relação), menos resistência
    // e freio.
    let accel = clutchTorque * gearbox.totalRatio(gear) * cfg.CLUTCH_DRIVE_GAIN;
    accel -= this._resistDecel(this._speed);
    accel -= cfg.BRAKE_DECEL * controls.brake;
    this._speed = Math.max(0, this._speed + accel * dt);

    // Trava quando a embreagem está fechada E as rotações já convergiram (acima
    // da marcha lenta da marcha, senão travar afogaria o motor). Como o
    // escorregamento já é pequeno, a sincronização é imperceptível.
    const newWheelRpm = gearbox.rpmFromSpeed(this._speed, gear);
    if (
      this._clutchEngage > 0.98 &&
      this._speed >= idleSpeed &&
      Math.abs(engine.rpm - newWheelRpm) <= cfg.CLUTCH_LOCK_SLIP
    ) {
      engine.clutchSync(newWheelRpm);
      this._clutchLocked = true;
    }
  }

  /**
   * Regime ACOPLADO: condução normal (embreagem travada). O motor integra com a
   * inércia refletida e a carga da pista; a velocidade deriva do RPM. O freio
   * reduz velocidade e RPM juntos. Se o freio (ou a resistência) levar abaixo da
   * marcha lenta da marcha, DESTRAVA a embreagem (volta a patinar) sem afogar.
   * @private
   */
  _stepCoupled(dt, engine, gearbox, controls) {
    const gear = gearbox.gear;
    const idleSpeed = gearbox.speedFromRpm(engine.cfg.IDLE_RPM, gear);

    const addedInertia = VEHICLE_DYNAMICS.INERTIA_SCALE * gearbox.reflectedInertia();
    const roadLoad = this._roadLoad(this._speed, gear);

    engine.update(dt, roadLoad, addedInertia);

    let speed = gearbox.speedFromRpm(engine.rpm, gear);

    if (controls.brake > 0) {
      speed = Math.max(0, speed - VEHICLE_DYNAMICS.BRAKE_DECEL * controls.brake * dt);
      const syncRpm = gearbox.rpmFromSpeed(speed, gear);
      engine.clutchSync(Math.max(syncRpm, engine.cfg.IDLE_RPM));
    }

    this._speed = speed;

    // Chegou na velocidade de marcha lenta da marcha: destrava (embreagem
    // patina) para poder parar suavemente sem afogar o motor.
    if (this._speed <= idleSpeed) this._clutchLocked = false;
  }

  // ---------------------------------------------------------------------------
  // Helpers de resistência
  // ---------------------------------------------------------------------------

  /**
   * Integra a velocidade sob resistência livre + freio (m/s²).
   * @private
   */
  _integrateFreeSpeed(speed, dt, brake) {
    const accel = -this._resistDecel(speed) - VEHICLE_DYNAMICS.BRAKE_DECEL * brake;
    return Math.max(0, speed + accel * dt);
  }

  /**
   * Desaceleração por resistência (rolagem + arrasto), em m/s².
   * @param {number} speed
   * @returns {number}
   * @private
   */
  _resistDecel(speed) {
    return VEHICLE_DYNAMICS.COAST_DECEL + VEHICLE_DYNAMICS.AERO_DECEL * speed * speed;
  }

  /**
   * Resistência da pista refletida ao virabrequim (regime acoplado), em rpm/s.
   * @private
   */
  _roadLoad(speed, gear) {
    const total = this._gearbox.totalRatio(gear);
    if (total <= 0) return 0;
    return (VEHICLE_DYNAMICS.ROAD_ROLL + VEHICLE_DYNAMICS.ROAD_DRAG * speed * speed) / total;
  }
}
