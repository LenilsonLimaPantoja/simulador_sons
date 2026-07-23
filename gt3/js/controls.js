/**
 * controls.js
 * -----------------------------------------------------------------------------
 * Abstração de ENTRADA do usuário (teclado) para o simulador.
 *
 * Responsabilidade única: traduzir eventos brutos de teclado em um pequeno
 * estado de entrada + eventos de alto nível ("subir marcha", "ignição"), sem
 * conhecer motor, áudio ou câmbio. Assim, trocar o esquema de teclas — ou
 * adicionar gamepad/touch no futuro — não afeta o resto do sistema.
 *
 * Mapeamento padrão:
 *   ↑ / W ............ acelerador (mantido = pleno; solto = 0)
 *   ↓ / S ............ freio (mantido = pleno; solto = 0)
 *   → / E ............ subir marcha (evento)
 *   ← / Q ............ reduzir marcha (evento)
 *   K ................ ligar/desligar o motor (evento)
 *   T ................ alternar câmbio automático (evento)
 *
 * O consumidor registra callbacks via on(evento, fn) e lê `controls.throttle`
 * e `controls.brake` a cada frame. Nenhuma lógica de simulação vive aqui.
 * Botões da interface podem alimentar as mesmas entradas via setThrottle/
 * setBrake (usados pelo main.js para os controles clicáveis).
 * -----------------------------------------------------------------------------
 */

/** Nomes de evento suportados. @type {ReadonlyArray<string>} */
const EVENTS = Object.freeze(['shiftUp', 'shiftDown', 'ignition', 'throttleChange', 'toggleAuto']);

export class Controls {
  /**
   * @param {EventTarget} [target=window]  Onde escutar os eventos de teclado.
   */
  constructor(target = window) {
    this._target = target;

    /** Estado de entrada contínuo. @type {{ throttle: number, brake: number }} */
    this._state = { throttle: 0, brake: 0 };

    /** Registro de callbacks por evento. */
    this._handlers = Object.fromEntries(EVENTS.map((e) => [e, []]));

    // Ligações fixas para poder remover os listeners depois.
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._attached = false;
  }

  /** @returns {number} Acelerador atual [0, 1]. */
  get throttle() {
    return this._state.throttle;
  }

  /** @returns {number} Freio atual [0, 1]. */
  get brake() {
    return this._state.brake;
  }

  /**
   * Define o acelerador diretamente (usado por botões da interface).
   * @param {number} value [0,1]
   */
  setThrottle(value) {
    this._state.throttle = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  /**
   * Define o freio diretamente (usado por botões da interface).
   * @param {number} value [0,1]
   */
  setBrake(value) {
    this._state.brake = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  // --- Gatilhos de evento para botões da interface (mesmos eventos do teclado) ---

  /** Dispara "subir marcha" (botão da interface). */
  uiShiftUp() {
    this._emit('shiftUp');
  }

  /** Dispara "reduzir marcha" (botão da interface). */
  uiShiftDown() {
    this._emit('shiftDown');
  }

  /** Dispara "ligar/desligar" (botão da interface). */
  uiIgnition() {
    this._emit('ignition');
  }

  /** Dispara "alternar automático" (botão da interface). */
  uiToggleAuto() {
    this._emit('toggleAuto');
  }

  /**
   * Registra um callback para um evento.
   * @param {'shiftUp'|'shiftDown'|'ignition'|'throttleChange'} event
   * @param {Function} handler
   * @returns {this}
   */
  on(event, handler) {
    if (!this._handlers[event]) throw new Error(`Controls: evento desconhecido "${event}".`);
    this._handlers[event].push(handler);
    return this;
  }

  /** Começa a escutar o teclado. Idempotente. */
  attach() {
    if (this._attached) return;
    this._target.addEventListener('keydown', this._onKeyDown);
    this._target.addEventListener('keyup', this._onKeyUp);
    this._attached = true;
  }

  /** Para de escutar o teclado e zera o acelerador. */
  detach() {
    if (!this._attached) return;
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._state.throttle = 0;
    this._state.brake = 0;
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Dispara todos os callbacks de um evento.
   * @param {string} event
   * @param {...any} args
   * @private
   */
  _emit(event, ...args) {
    for (const fn of this._handlers[event]) fn(...args);
  }

  /**
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyDown(e) {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        e.preventDefault();
        if (e.repeat) return; // borda de subida apenas
        this._state.throttle = 1;
        this._emit('throttleChange', true);
        break;

      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault();
        this._state.brake = 1;
        break;

      case 'KeyT':
        e.preventDefault();
        if (e.repeat) return;
        this._emit('toggleAuto');
        break;

      case 'ArrowRight':
      case 'KeyE':
        e.preventDefault();
        if (e.repeat) return;
        this._emit('shiftUp');
        break;

      case 'ArrowLeft':
      case 'KeyQ':
        e.preventDefault();
        if (e.repeat) return;
        this._emit('shiftDown');
        break;

      case 'KeyK':
        e.preventDefault();
        if (e.repeat) return;
        this._emit('ignition');
        break;

      default:
        break;
    }
  }

  /**
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyUp(e) {
    if (e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      this._state.throttle = 0;
      this._emit('throttleChange', false);
    } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
      e.preventDefault();
      this._state.brake = 0;
    }
  }
}
