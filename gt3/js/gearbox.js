/**
 * gearbox.js
 * -----------------------------------------------------------------------------
 * Câmbio: CINEMÁTICA e ESTADO da transmissão (apenas números — sem áudio/DOM).
 *
 * Responsabilidade única:
 *   - Guardar as relações de marcha e o final drive.
 *   - Converter entre RPM do motor e velocidade do veículo (embreagem travada).
 *   - Manter a marcha atual e a máquina de troca (subir/descer/neutro).
 *   - Classificar o som de redução (par/ímpar) por marcha.
 *
 * FRONTEIRA DE ARQUITETURA (importante):
 *   Este módulo NÃO integra o movimento do veículo nem calcula o torque de
 *   carga sobre o motor. A DINÂMICA ACOPLADA (massa do carro, inércia refletida
 *   que faz cada marcha responder diferente, queda de RPM na troca) pertence ao
 *   orquestrador `vehicle.js` (Etapa 7), pois envolve motor + câmbio juntos.
 *   Aqui deixamos apenas os HELPERS puros que essa dinâmica consumirá
 *   (`totalRatio`, `reflectedInertia`, `rpmFromSpeed`), mantendo cada arquivo
 *   com uma responsabilidade só.
 * -----------------------------------------------------------------------------
 */

import { clamp } from './utils.js';

/**
 * Dados de calibração da transmissão. Congelados (não são estado).
 * @type {Readonly<object>}
 */
export const GEARBOX_CONFIG = Object.freeze({
  // Relações das 6 marchas (índice 0 => 1ª marcha).
  GEAR_RATIOS: Object.freeze([2.786, 2.125, 1.722, 1.440, 1.240, 1.074]),

  FINAL_DRIVE: 3.5,

  // Diâmetro de rolagem do pneu traseiro (m). GT3 ~ slick 31/71-18 ≈ 0,72 m.
  TIRE_DIAMETER_M: 0.72,

  // Massa do veículo (kg) — usada pela dinâmica da Etapa 7 (inércia refletida).
  VEHICLE_MASS_KG: 1300,

  NEUTRAL: 0, // marcha 0 = neutro (motor desacoplado das rodas)
});

/** Circunferência do pneu em metros (perímetro percorrido por volta da roda). */
const TIRE_CIRCUMFERENCE_M = Math.PI * GEARBOX_CONFIG.TIRE_DIAMETER_M;

export class Gearbox {
  constructor(config = GEARBOX_CONFIG) {
    this.cfg = config;

    /** Marcha atual: 0 = neutro, 1..N = marchas. @type {number} */
    this._gear = config.NEUTRAL;
  }

  // ---------------------------------------------------------------------------
  // Estado da marcha
  // ---------------------------------------------------------------------------

  /** @returns {number} Marcha atual (0 = neutro). */
  get gear() {
    return this._gear;
  }

  /** @returns {boolean} */
  get isNeutral() {
    return this._gear === this.cfg.NEUTRAL;
  }

  /** @returns {number} Número de marchas para frente. */
  get gearCount() {
    return this.cfg.GEAR_RATIOS.length;
  }

  /** @returns {boolean} Está na marcha mais alta. */
  get isTopGear() {
    return this._gear === this.gearCount;
  }

  // ---------------------------------------------------------------------------
  // Relações
  // ---------------------------------------------------------------------------

  /**
   * Relação total (marcha × final drive) de uma marcha.
   * @param {number} [gear=this._gear]
   * @returns {number} 0 no neutro (desacoplado).
   */
  totalRatio(gear = this._gear) {
    if (gear < 1 || gear > this.gearCount) return 0;
    return this.cfg.GEAR_RATIOS[gear - 1] * this.cfg.FINAL_DRIVE;
  }

  // ---------------------------------------------------------------------------
  // Conversões RPM <-> velocidade (embreagem travada, sem escorregamento)
  // ---------------------------------------------------------------------------

  /**
   * Velocidade do veículo a partir do RPM do motor, numa dada marcha.
   *
   * rodaRPM   = rpmMotor / relaçãoTotal
   * v (m/s)   = (rodaRPM / 60) × circunferênciaDoPneu
   *
   * @param {number} rpm
   * @param {number} [gear=this._gear]
   * @returns {number} Velocidade em m/s (0 no neutro).
   */
  speedFromRpm(rpm, gear = this._gear) {
    const ratio = this.totalRatio(gear);
    if (ratio <= 0) return 0; // neutro: velocidade não é definida pelo RPM
    const wheelRpm = rpm / ratio;
    return (wheelRpm / 60) * TIRE_CIRCUMFERENCE_M;
  }

  /**
   * RPM do motor correspondente a uma velocidade, numa dada marcha. Inverso de
   * speedFromRpm — usado pela dinâmica da troca (a Etapa 7 calcula o novo RPM
   * mantendo a velocidade contínua na embreagem).
   *
   * @param {number} speedMs  Velocidade em m/s.
   * @param {number} [gear=this._gear]
   * @returns {number} RPM do motor (0 no neutro).
   */
  rpmFromSpeed(speedMs, gear = this._gear) {
    const ratio = this.totalRatio(gear);
    if (ratio <= 0) return 0;
    const wheelRpm = (speedMs / TIRE_CIRCUMFERENCE_M) * 60;
    return wheelRpm * ratio;
  }

  /**
   * Inércia do veículo REFLETIDA ao eixo do motor, para uma marcha.
   * Helper puro para a dinâmica da Etapa 7: a mesma massa "pesa" mais nas
   * marchas altas (relação menor) — é o que faz a 6ª subir de giro devagar e a
   * 1ª estourar rápido.
   *
   * I_refletida = m × (circunferência / (2π × relaçãoTotal))²
   *
   * @param {number} [gear=this._gear]
   * @returns {number} Inércia equivalente (kg·m²); 0 no neutro.
   */
  reflectedInertia(gear = this._gear) {
    const ratio = this.totalRatio(gear);
    if (ratio <= 0) return 0;
    const dvPerRad = TIRE_CIRCUMFERENCE_M / (2 * Math.PI * ratio);
    return this.cfg.VEHICLE_MASS_KG * dvPerRad * dvPerRad;
  }

  // ---------------------------------------------------------------------------
  // Máquina de troca de marchas
  // ---------------------------------------------------------------------------

  /**
   * Descrição do resultado de uma troca.
   * @typedef {object} ShiftResult
   * @property {boolean} changed    Houve mudança de marcha.
   * @property {number}  from       Marcha anterior.
   * @property {number}  to         Nova marcha.
   * @property {'up'|'down'|'none'} direction
   * @property {string|null} sample Nome lógico do som ('gear_up' |
   *                                'gear_down_even' | 'gear_down_odd' | null).
   */

  /**
   * Sobe uma marcha (neutro -> 1ª -> ... -> topo). Não passa do topo.
   * @returns {ShiftResult}
   */
  shiftUp() {
    if (this._gear >= this.gearCount) return this._noShift();
    const from = this._gear;
    this._gear += 1;
    return { changed: true, from, to: this._gear, direction: 'up', sample: 'gear_up' };
  }

  /**
   * Desce uma marcha (topo -> ... -> 1ª -> neutro). Não passa do neutro.
   * O som depende da PARIDADE da marcha de destino (par/ímpar).
   * @returns {ShiftResult}
   */
  shiftDown() {
    if (this._gear <= this.cfg.NEUTRAL) return this._noShift();
    const from = this._gear;
    this._gear -= 1;
    return {
      changed: true,
      from,
      to: this._gear,
      direction: 'down',
      sample: this._downshiftSample(this._gear),
    };
  }

  /**
   * Vai direto para o neutro (ex.: ao desligar).
   * @returns {ShiftResult}
   */
  toNeutral() {
    if (this.isNeutral) return this._noShift();
    const from = this._gear;
    this._gear = this.cfg.NEUTRAL;
    return { changed: true, from, to: this._gear, direction: 'down', sample: null };
  }

  /**
   * Escolhe o som de redução conforme a paridade da marcha de destino.
   * Neutro não tem som de redução.
   * @param {number} gear
   * @returns {string|null}
   * @private
   */
  _downshiftSample(gear) {
    if (gear <= this.cfg.NEUTRAL) return null;
    return gear % 2 === 0 ? 'gear_down_even' : 'gear_down_odd';
  }

  /** @returns {ShiftResult} Resultado "sem troca". @private */
  _noShift() {
    return { changed: false, from: this._gear, to: this._gear, direction: 'none', sample: null };
  }

  // ---------------------------------------------------------------------------
  // Utilitário estático
  // ---------------------------------------------------------------------------

  /**
   * Converte m/s para km/h.
   * @param {number} speedMs
   * @returns {number}
   */
  static toKmh(speedMs) {
    return speedMs * 3.6;
  }
}
