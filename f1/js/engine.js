/**
 * engine.js
 * -----------------------------------------------------------------------------
 * Simulação do MOTOR (apenas a dinâmica de RPM — não é física real).
 *
 * O objetivo é gerar um valor de RPM que "sinta" como um V8: sobe conforme o
 * acelerador e a marcha, cai por freio-motor ao soltar, dá uma acelerada ao
 * ligar (flare) e bate no limitador.
 *
 * Não sabe nada sobre áudio nem sobre a UI.
 * -----------------------------------------------------------------------------
 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Aproximação exponencial (independente de frame-rate). */
const expApproach = (current, target, rate, dt) =>
    current + (target - current) * (1 - Math.exp(-rate * dt));

export class Engine {
    constructor(config) {
        this.config = config.engine;

        this.rpm = 0;             // RPM real (usado pelo ÁUDIO e pela velocidade)
        this.displayRpm = 0;      // RPM exibido (mostrador) — sobe devagar na partida
        this.throttleInput = 0;   // alvo cru do acelerador (0..1)
        this.throttle = 0;        // acelerador suavizado (0..1) — usado na UI
        this.audioThrottle = 0;   // acelerador efetivo (inclui o flare) — usado no áudio
        this.brakeInput = 0;      // freio (0..1)
        this.load = 0;            // carga do motor (0..1)
        this.running = false;
        this.limiterActive = false;

        this._flare = 0;          // piso de acelerador do flare de partida
        this._spinUp = false;     // mostrador subindo até a lenta na partida?
        this._spinDown = false;   // mostrador descendo até 0 ao desligar?
    }

    /**
     * Inicia a subida do MOSTRADOR (0 -> lenta), chamado no começo da partida —
     * antes mesmo da combustão, para o ponteiro subir durante o som de partida.
     */
    beginStartupDisplay() {
        this.displayRpm = 0;
        this._spinUp = true;
        this._spinDown = false;
    }

    /** Liga o motor: o áudio parte da lenta na hora (o mostrador já vem subindo). */
    start() {
        this.running = true;
        this.rpm = this.config.idleRPM;
        this._flare = this.config.startupFlare;
    }

    /** Desliga o motor. O mostrador desce devagar até 0 (não zera na hora). */
    stop() {
        this.running = false;
        this.throttleInput = 0;
        this.throttle = 0;
        this.audioThrottle = 0;
        this.brakeInput = 0;
        this.rpm = 0;
        this._spinUp = false;
        this._spinDown = true;   // ponteiro desce até 0 na mesma taxa da subida
        this._flare = 0;
        this.limiterActive = false;
    }

    /** Define o acelerador (0..1). */
    setThrottle(value) {
        this.throttleInput = clamp(value, 0, 1);
    }

    /** Define o freio (0..1). */
    setBrake(value) {
        this.brakeInput = clamp(value, 0, 1);
    }

    /**
     * Integra um passo de tempo.
     * @param {number} dt          - delta em segundos
     * @param {number} accelRate   - taxa de subida de RPM da marcha atual (rpm/s)
     */
    update(dt, accelRate) {
        if (!this.running) return;
        const c = this.config;

        // Suaviza o acelerador (resposta do pedal).
        this.throttle = expApproach(this.throttle, this.throttleInput, 1 / c.throttleResponse, dt);

        // Flare de partida: decai a zero e funciona como piso do acelerador.
        this._flare = expApproach(this._flare, 0, c.startupFlareDecay, dt);

        // Desacelerando: corta o acelerador (o freio sempre vence a aceleração).
        const braking = this.brakeInput > 0;
        this.audioThrottle = braking ? 0 : Math.max(this.throttle, this._flare);

        // Aceleração de RPM: potência efetiva menos arrasto, freio-motor e freio.
        const drive = this.audioThrottle * accelRate;
        const engineBrake = (1 - this.audioThrottle) * c.engineBraking;
        const brake = this.brakeInput * c.brakeForce;
        const deltaRpm = (drive - c.internalDrag - engineBrake - brake) * dt;

        this.rpm = clamp(this.rpm + deltaRpm, c.idleRPM, c.maxRPM);

        // Limitador: usa o acelerador REAL (o flare não deve disparar o corte).
        this.limiterActive = (this.rpm >= c.limiterRPM - 1) && this.throttle > 0.5;
        if (this.limiterActive) this.rpm = c.limiterRPM;

        // Carga do motor (para o áudio).
        this.load = clamp(this.audioThrottle * 0.7 + (this.rpm / c.maxRPM) * 0.3, 0, 1);
    }

    /**
     * Atualiza o RPM do MOSTRADOR. Roda todo frame (inclusive antes da combustão,
     * durante o som de partida). Na partida sobe linear até a lenta; depois
     * acompanha o RPM real exatamente (sem lag ao dirigir).
     * @param {number} dt
     */
    updateDisplay(dt) {
        const c = this.config;
        const rate = c.startupRevRate;

        // Desligando: desce devagar até 0 (mesma taxa da subida na partida).
        if (this._spinDown) {
            this.displayRpm = Math.max(0, this.displayRpm - rate * dt);
            if (this.displayRpm <= 0) this._spinDown = false;
            return;
        }

        // Antes de ligar, o alvo é a lenta; ligado, é o RPM real.
        const target = this.running ? this.rpm : c.idleRPM;
        if (this._spinUp) {
            this.displayRpm = Math.min(target, this.displayRpm + rate * dt);
            if (this.displayRpm >= target - 1) this._spinUp = false;
        } else {
            this.displayRpm = this.running ? this.rpm : this.displayRpm;
        }
    }

    /**
     * Reposiciona o RPM (rev-matching na troca de marcha). Único ponto em que o
     * RPM é imposto de fora — representa a embreagem casando motor e velocidade.
     * @param {number} value  RPM alvo (será limitado à faixa útil).
     */
    setRpm(value) {
        const c = this.config;
        this.rpm = clamp(value, c.idleRPM, c.maxRPM);
    }

    /** Estado consumido pelo áudio e pela UI. */
    getState() {
        return {
            rpm: this.rpm,                     // real -> áudio e velocidade
            displayRpm: this.displayRpm,       // mostrador -> tacômetro/número
            throttle: this.throttle,           // pedal real (UI)
            audioThrottle: this.audioThrottle, // efetivo (mix de marcha)
            load: this.load,
            running: this.running,
            limiterActive: this.limiterActive,
        };
    }
}
