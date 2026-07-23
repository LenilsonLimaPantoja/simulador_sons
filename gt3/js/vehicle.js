/**
 * vehicle.js — GT3 com o modelo de dirigibilidade do F1 (liso)
 * -----------------------------------------------------------------------------
 * Substitui a física de embreagem realista do GT3 pelo modelo simples do F1:
 *   - RPM integrado a partir do acelerador (taxa por marcha), sem patinagem.
 *   - Velocidade sai do RPM (embreagem sempre travada); no neutro o carro desliza.
 *   - Rev-matching nas trocas (o giro casa com a velocidade da nova marcha).
 * Mantém 100% o SOM (EngineSound), o PAINEL (Dashboard) e os CONTROLES do GT3.
 *
 * Ajuste o "feel" pelos valores em CFG (taxas por marcha, velocidades, auto).
 * -----------------------------------------------------------------------------
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const expApproach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/** Calibração (mesma estrutura do F1, valores do GT3). */
const CFG = Object.freeze({
  IDLE: 1164,
  MAX: 8500,
  REDLINE: 8200,
  LIMITER: 8500,

  // Subida de RPM por marcha (rpm/s) com acelerador cheio. 1ª mais viva.
  // >>> AJUSTE A ACELERAÇÃO AQUI <<< (menor = sobe de giro mais devagar).
  // Índice 0 = 1ª marcha, ... índice 5 = 6ª.
  accelRates: [2800, 2300, 1900, 1600, 1300, 1100],
  neutralAccel: 7000,     // neutro: motor livre (blip parado)
  engineBraking: 2000,    // queda de RPM ao soltar (rpm/s)
  internalDrag: 700,      // arrasto interno (rpm/s)
  throttleResponse: 0.10, // constante de tempo do acelerador (s)
  brakeForce: 5000,       // desaceleração extra do freio (rpm/s)

  // Velocidade (km/h) na redline em cada marcha (define o rev-match).
  gearSpeeds: [70, 105, 145, 190, 245, 300],

  // Câmbio automático.
  autoUpRPM: 7900,
  autoDownRPM: [0, 5000, 5500, 6000, 6500, 7000], // índice = marcha-1
  autoShiftCooldown: 0.5,
  shiftCooldown: 0.12,

  // Neutro (velocidade desacoplada).
  coastDecel: 7,   // km/h por s
  brakeDecel: 65,  // km/h por s

  // Acelerada de partida (flare).
  startupFlare: 0.6,
  startupFlareDecay: 2.6,

  displaySmooth: 40, // suavização do RPM exibido/áudio (maior = mais colado)
  MAX_DT: 0.05,
});

export class Vehicle {
  constructor({ engineSound, dashboard, controls }) {
    this._sound = engineSound;
    this._dash = dashboard;
    this._controls = controls;

    this._rpm = 0;
    this._displayRpm = 0;
    this._throttle = 0;
    this._flare = 0;
    this._speed = 0;      // km/h
    this._gear = 0;       // 0 = neutro, 1..N
    this._running = false;
    this._limiting = false;

    this._auto = true;
    this._autoCooldown = 0;
    this._shiftCooldown = 0;
    this._busy = false;

    this._rafId = null;
    this._lastTime = 0;
    this._loop = this._loop.bind(this);

    this.onAutoChange = null;
    this.onRunningChange = null;
  }

  get isAuto() { return this._auto; }
  get gearCount() { return CFG.accelRates.length; }

  /* ---------------------- ciclo de vida ---------------------- */

  start() {
    this._wireControls();
    this._controls.attach();
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._loop);
  }

  destroy() {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this._controls.detach();
    if (this._sound.isStarted) this._sound.stop();
  }

  async ignite() {
    if (this._busy || this._running) return;
    this._busy = true;
    this._sound.start();
    this._running = true;
    this._gear = 0;                 // parte em neutro
    this._rpm = CFG.IDLE;
    this._flare = CFG.startupFlare; // acelerada de partida
    await this._sound.ignite();     // starter + revela o banco
    this._emitRunning(true);
    this._busy = false;
  }

  async shutdown() {
    if (this._busy || !this._running) return;
    this._busy = true;
    this._running = false;
    this._limiting = false;
    this._emitRunning(false);
    await this._sound.shutdown();
    this._sound.stop();
    this._resetMotion();
    this._busy = false;
  }

  /** Corte de energia (chave DISPLAY desligada). */
  powerDown() {
    if (this._running) this._sound.shutdown().then(() => this._sound.stop());
    this._running = false;
    this._limiting = false;
    this._resetMotion();
    this._emitRunning(false);
  }

  _resetMotion() {
    this._rpm = 0;
    this._displayRpm = 0;
    this._throttle = 0;
    this._flare = 0;
    this._speed = 0;
    this._gear = 0;
  }

  /* ---------------------- câmbio automático ---------------------- */

  setAuto(value = !this._auto) {
    this._auto = value;
    if (typeof this.onAutoChange === 'function') this.onAutoChange(this._auto);
  }
  toggleAuto() { this.setAuto(!this._auto); }

  _autoShift(dt) {
    this._autoCooldown = Math.max(0, this._autoCooldown - dt);
    if (this._autoCooldown > 0) return;
    const th = this._controls.throttle;

    if (this._gear === 0) {
      if (th > 0.05) this._autoDo(() => this._shiftUp());
      return;
    }
    if (th > 0.2 && this._gear < this.gearCount && this._rpm >= CFG.autoUpRPM) {
      this._autoDo(() => this._shiftUp());
      return;
    }
    if (this._gear > 1 && th < 0.1) {
      const downAt = CFG.autoDownRPM[this._gear - 1];
      if (this._rpm <= downAt) this._autoDo(() => this._shiftDown());
    }
  }

  _autoDo(fn) { fn(); this._autoCooldown = CFG.autoShiftCooldown; }

  /* ---------------------- controles ---------------------- */

  _wireControls() {
    this._controls
      .on('shiftUp', () => this._shiftUp())
      .on('shiftDown', () => this._shiftDown())
      .on('ignition', () => (this._running ? this.shutdown() : this.ignite()))
      .on('toggleAuto', () => this.toggleAuto());
  }

  /* ---------------------- trocas (rev-match) ---------------------- */

  _maxSpeed(g = this._gear) { return g < 1 ? 0 : CFG.gearSpeeds[g - 1]; }

  _shiftUp() {
    if (!this._running || this._shiftCooldown > 0 || this._gear >= this.gearCount) return;
    const speed = this._speed;
    this._gear++;
    this._shiftCooldown = CFG.shiftCooldown;
    this._sound.playShift('gear_up');
    this._revMatch(speed);
  }

  _shiftDown() {
    if (!this._running || this._shiftCooldown > 0 || this._gear <= 0) return;
    const speed = this._speed;
    this._gear--;
    this._shiftCooldown = CFG.shiftCooldown;
    if (this._gear >= 1) {
      this._sound.playShift(this._gear % 2 === 0 ? 'gear_down_even' : 'gear_down_odd');
    }
    this._revMatch(speed);
  }

  /** Casa o RPM à velocidade na nova marcha (subida: cai; redução: sobe). */
  _revMatch(speed) {
    const ms = this._maxSpeed();
    if (ms <= 0) return; // neutro: motor livre
    const frac = speed / ms;
    this._rpm = clamp(CFG.IDLE + frac * (CFG.REDLINE - CFG.IDLE), CFG.IDLE, CFG.MAX);
  }

  /* ---------------------- laço de simulação ---------------------- */

  _loop(now) {
    const dt = Math.min((now - this._lastTime) / 1000, CFG.MAX_DT);
    this._lastTime = now;
    this._step(dt);
    this._rafId = requestAnimationFrame(this._loop);
  }

  _step(dt) {
    if (this._shiftCooldown > 0) this._shiftCooldown = Math.max(0, this._shiftCooldown - dt);

    if (this._running) {
      if (this._auto) this._autoShift(dt);
      this._updateEngine(dt);
      this._updateSpeed(dt);
    }

    // RPM exibido/áudio (levemente suavizado).
    this._displayRpm = expApproach(this._displayRpm, this._running ? this._rpm : 0, CFG.displaySmooth, dt);

    if (this._running) {
      this._sound.update(this._displayRpm);
      this._sound.setLimiter(this._limiting);
    }

    this._dash.update({
      rpm: this._displayRpm,
      speedKmh: this._speed,
      gear: this._gear,
      atRedline: this._rpm >= CFG.REDLINE,
      limiting: this._limiting,
      braking: this._controls.brake > 0.01,
      tc: false,
    });
  }

  _updateEngine(dt) {
    const c = CFG;
    this._throttle = expApproach(this._throttle, this._controls.throttle, 1 / c.throttleResponse, dt);
    this._flare = expApproach(this._flare, 0, c.startupFlareDecay, dt);

    const braking = this._controls.brake > 0;
    const eff = braking ? 0 : Math.max(this._throttle, this._flare);
    const accelRate = this._gear === 0 ? c.neutralAccel : c.accelRates[this._gear - 1];

    const drive = eff * accelRate;
    const engBrake = (1 - eff) * c.engineBraking;
    const brk = this._controls.brake * c.brakeForce;
    this._rpm = clamp(this._rpm + (drive - c.internalDrag - engBrake - brk) * dt, c.IDLE, c.MAX);

    this._limiting = (this._rpm >= c.LIMITER - 1) && this._throttle > 0.5;
    if (this._limiting) this._rpm = c.LIMITER;
  }

  _updateSpeed(dt) {
    if (this._gear === 0) {
      const decel = CFG.coastDecel + this._controls.brake * CFG.brakeDecel;
      this._speed = Math.max(0, this._speed - decel * dt);
    } else {
      const frac = clamp((this._rpm - CFG.IDLE) / (CFG.REDLINE - CFG.IDLE), 0, 1);
      this._speed = frac * this._maxSpeed();
    }
  }

  _emitRunning(running) {
    if (typeof this.onRunningChange === 'function') this.onRunningChange(running);
  }
}
