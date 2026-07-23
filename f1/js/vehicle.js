/**
 * vehicle.js
 * -----------------------------------------------------------------------------
 * Velocidade do veículo em dois regimes:
 *
 *   • EM MARCHA (embreagem travada): a velocidade deriva do RPM e da marcha.
 *   • NEUTRO (desacoplado): o carro apenas desliza (coasting) e o freio o
 *     desacelera; a velocidade tem inércia própria, independente do RPM.
 *
 * Não é física real — apenas um mapeamento coerente com o som.
 * -----------------------------------------------------------------------------
 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class Vehicle {
    constructor(config) {
        this.config = config;
        this.speed = 0; // km/h
    }

    /**
     * Recalcula a velocidade.
     * @param {number}  dt       - delta em segundos
     * @param {Engine}  engine
     * @param {Gearbox} gearbox
     */
    update(dt, engine, gearbox) {
        if (gearbox.isNeutral) {
            // Neutro: desacoplado — desliza e o freio segura.
            const v = this.config.vehicle;
            const decel = v.coastDecel + engine.brakeInput * v.brakeDecel;
            this.speed = Math.max(0, this.speed - decel * dt);
        } else {
            // Em marcha: a velocidade acompanha o RPM (embreagem travada).
            // A faixa ÚTIL (idle -> redline) mapeia 0 -> maxSpeed, então na
            // marcha lenta a velocidade é 0 (nada de "24 km/h" parado).
            const { idleRPM, redlineRPM } = this.config.engine;
            const frac = clamp((engine.rpm - idleRPM) / (redlineRPM - idleRPM), 0, 1);
            this.speed = frac * gearbox.maxSpeed();
        }
    }

    reset() { this.speed = 0; }

    getState() {
        return { speed: this.speed };
    }
}
