/**
 * gearbox.js
 * -----------------------------------------------------------------------------
 * Câmbio de N marchas (7 por padrão) + NEUTRO.
 *
 * Marchas: 0 = neutro (desacoplado das rodas), 1..gearCount = marchas.
 * Cuida só da lógica: marcha atual, se pode subir/reduzir, relações e
 * velocidades. O rev-matching e o som da troca são coordenados pelo app.
 * -----------------------------------------------------------------------------
 */

export class Gearbox {
    constructor(config) {
        this.config = config.gearbox;
        this.gear = 0;                    // começa em NEUTRO
        this._cooldown = 0;               // tempo restante até poder trocar (s)
    }

    /** Atualiza o cooldown de troca. */
    update(dt) {
        if (this._cooldown > 0) this._cooldown = Math.max(0, this._cooldown - dt);
    }

    get gearCount() { return this.config.gearCount; }

    /** Está em neutro? */
    get isNeutral() { return this.gear === 0; }

    /** Relação da marcha (0 no neutro). */
    ratio(gear = this.gear) {
        return gear < 1 ? 0 : this.config.gearRatios[gear - 1];
    }

    /** Velocidade máxima (km/h, na redline) da marcha (0 no neutro). */
    maxSpeed(gear = this.gear) {
        return gear < 1 ? 0 : this.config.gearSpeeds[gear - 1];
    }

    canShiftUp()   { return this._cooldown === 0 && this.gear < this.gearCount; }
    canShiftDown() { return this._cooldown === 0 && this.gear > 0; }

    /**
     * Sobe uma marcha (neutro -> 1ª -> ... -> topo).
     * @returns {boolean} true se trocou.
     */
    shiftUp() {
        if (!this.canShiftUp()) return false;
        this.gear++;
        this._cooldown = this.config.shiftCooldown;
        return true;
    }

    /**
     * Reduz uma marcha (topo -> ... -> 1ª -> neutro).
     * @returns {boolean} true se trocou.
     */
    shiftDown() {
        if (!this.canShiftDown()) return false;
        this.gear--;
        this._cooldown = this.config.shiftCooldown;
        return true;
    }

    /** Volta para o neutro (usado ao ligar/desligar). */
    reset() {
        this.gear = 0;
        this._cooldown = 0;
    }
}
