/**
 * app.js — F1 V8 (app de veículo único)
 * -----------------------------------------------------------------------------
 * Monta os módulos com o CONFIG do F1 e roda o loop principal (motor -> áudio ->
 * UI). Sem seletor: este app é só o F1 (o GT3 é um app à parte, em ../gt3).
 * -----------------------------------------------------------------------------
 */

import { CONFIG } from './config.js';
import { AudioEngine, EngineSoundController } from './audioEngine.js';
import { Engine } from './engine.js';
import { Gearbox } from './gearbox.js';
import { Vehicle } from './vehicle.js';
import { Controls } from './controls.js';
import { UI } from './ui.js';

class App {
    constructor() {
        this.config = CONFIG;

        this.engine = new Engine(CONFIG);
        this.gearbox = new Gearbox(CONFIG);
        this.vehicle = new Vehicle(CONFIG);
        this.audio = new AudioEngine(CONFIG);
        this.sound = new EngineSoundController(this.audio, CONFIG);

        this._lastTime = 0;
        this._starting = false;
        this._switchReady = false;
        this._audioReady = null;
        this._powered = false;
        this._busy = false;
        this._auto = CONFIG.gearbox.autoStartDefault;
        this._autoCooldown = 0;

        this._cacheDom();
        this._initUiAndControls();
        this._applyVehicleVisual();
        this._preload();
        this._startLoop();
    }

    _cacheDom() {
        const $ = (id) => document.getElementById(id);
        this.el = {
            dashboard: document.querySelector('.dashboard'),
            logo: $('vehicle-logo'),
            displaySwitch: $('display-switch'),
            tach: $('tach'),
            tachNeedle: $('tach-needle'),
            rpmValue: $('rpm-value'),
            speedValue: $('speed-value'),
            gearValue: $('gear-value'),
            engine: $('btn-engine'),
            up: $('btn-up'),
            down: $('btn-down'),
            brake: $('btn-brake'),
            gas: $('btn-gas'),
            auto: $('btn-auto'),
        };
    }

    _initUiAndControls() {
        this.ui = new UI(this.el);
        this.ui.setConfig(CONFIG);
        this.controls = new Controls(this.el, {
            onTogglePower:  () => this.togglePower(),
            onToggleEngine: () => this.toggleEngine(),
            onShiftUp:      () => this.shiftUp(),
            onShiftDown:    () => this.shiftDown(),
            onThrottle:     (v) => this.engine.setThrottle(v),
            onBrake:        (v) => this.engine.setBrake(v),
            onToggleAuto:   () => this.toggleAuto(),
        });
        this._updateAutoButton();
        this._syncControls();
        this.el.dashboard.classList.add('dashboard--off');
        this.ui.render(this._collectState());
    }

    _applyVehicleVisual() {
        document.body.style.setProperty('--veh-bg', `url('${CONFIG.ui.background}')`);
        if (this.el.logo) { this.el.logo.src = CONFIG.ui.logo; this.el.logo.alt = CONFIG.name; }
    }

    async _preload() {
        await this.audio.loadSome([CONFIG.power.switchSound, CONFIG.power.primeSound]);
        this._switchReady = true;
        this.controls.setDisplayReady(true);
        this._audioReady = this.audio.loadAll().then(() => this.sound.build());
    }

    _syncControls() {
        this.controls.setState(this._powered, this.engine.running);
    }

    /* ---------------------- ações ---------------------- */

    togglePower() { if (this._powered) this.powerOff(); else this.powerOn(); }

    async powerOn() {
        if (!this._switchReady || this._powered || this._busy) return;
        this._busy = true;
        this._powered = true;
        this.el.displaySwitch.setAttribute('aria-pressed', 'true');
        this.el.dashboard.classList.remove('dashboard--off');
        this.controls.setEngineLoading(true);
        await this.audio.resume();
        await this.sound.powerOnSequence();
        await this._audioReady;
        this.controls.setEngineLoading(false);
        this._syncControls();
        this._busy = false;
    }

    toggleEngine() { if (this.engine.running) this.stop(); else this.start(); }

    powerOff() {
        if (!this._powered || this._busy) return;
        if (this.engine.running) this.stop();
        this.sound.playPowerSwitch();
        this._powered = false;
        this.el.dashboard.classList.add('dashboard--off');
        this._syncControls();
    }

    async start() {
        if (!this._powered || this.engine.running || this._starting) return;
        this._starting = true;
        this.controls.setEngineLoading(true);
        await this.audio.resume();
        await this._audioReady;
        this.gearbox.reset();
        setTimeout(() => {
            if (this._starting || this.engine.running) this.engine.beginStartupDisplay();
        }, CONFIG.engine.startupRevDelay * 1000);
        await this.sound.startupSequence(() => this.engine.start());
        this.controls.setEngineLoading(false);
        this._syncControls();
        this._starting = false;
    }

    async stop() {
        if (!this.engine.running) return;
        this.engine.stop();
        this.vehicle.reset();
        this.gearbox.reset();
        this._syncControls();
        await this.sound.shutdown();
    }

    shiftUp() {
        if (!this.engine.running) return;
        const speed = this.vehicle.speed;
        if (!this.gearbox.shiftUp()) return;
        this.sound.playGearUp();
        this._revMatch(speed);
    }

    shiftDown() {
        if (!this.engine.running) return;
        const speed = this.vehicle.speed;
        if (!this.gearbox.shiftDown()) return;
        this.sound.playGearDown(this.gearbox.gear);
        this._revMatch(speed);
    }

    toggleAuto() { this._auto = !this._auto; this._updateAutoButton(); }

    _updateAutoButton() {
        this.el.auto.textContent = 'AUTO: ' + (this._auto ? 'ON' : 'OFF');
        this.el.auto.classList.toggle('is-active', this._auto);
    }

    _autoShift(dt) {
        this._autoCooldown = Math.max(0, this._autoCooldown - dt);
        if (this._autoCooldown > 0) return;
        const cfg = CONFIG.gearbox;
        const gb = this.gearbox;
        const rpm = this.engine.rpm;
        const throttle = this.engine.throttle;
        if (gb.isNeutral) {
            if (throttle > 0.05) this._autoDo(() => this.shiftUp());
            return;
        }
        if (throttle > 0.2 && gb.gear < gb.gearCount && rpm >= cfg.autoUpRPM) {
            this._autoDo(() => this.shiftUp());
            return;
        }
        if (gb.gear > 1 && throttle < 0.1) {
            const downAt = cfg.autoDownRPM[gb.gear - 1];
            if (rpm <= downAt) this._autoDo(() => this.shiftDown());
        }
    }

    _autoDo(shiftFn) { shiftFn(); this._autoCooldown = CONFIG.gearbox.autoShiftCooldown; }

    _revMatch(speed) {
        const maxSpeed = this.gearbox.maxSpeed();
        if (maxSpeed <= 0) return;
        const { idleRPM, redlineRPM } = CONFIG.engine;
        const frac = speed / maxSpeed;
        this.engine.setRpm(idleRPM + frac * (redlineRPM - idleRPM));
    }

    /* ---------------------- loop principal ---------------------- */

    _startLoop() {
        this._lastTime = performance.now();
        const frame = (now) => {
            const dt = Math.min((now - this._lastTime) / 1000, 0.05);
            this._lastTime = now;
            this._tick(dt);
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    _tick(dt) {
        this.gearbox.update(dt);
        if (this.engine.running) {
            if (this._auto) this._autoShift(dt);
            const accelRate = this.gearbox.isNeutral
                ? CONFIG.engine.neutralAccel
                : CONFIG.engine.accelerationRates[this.gearbox.gear - 1];
            this.engine.update(dt, accelRate);
            this.vehicle.update(dt, this.engine, this.gearbox);
        }
        this.engine.updateDisplay(dt);
        const state = this._collectState();
        if (this.engine.running) this.sound.update(state);
        this.ui.render(state);
    }

    _collectState() {
        const e = this.engine.getState();
        const v = this.vehicle.getState();
        return {
            rpm: e.rpm,
            displayRpm: e.displayRpm,
            throttle: e.throttle,
            audioThrottle: e.audioThrottle,
            load: e.load,
            running: e.running,
            limiterActive: e.limiterActive,
            gear: this.gearbox.gear,
            speed: v.speed,
        };
    }
}

window.addEventListener('DOMContentLoaded', () => new App());
