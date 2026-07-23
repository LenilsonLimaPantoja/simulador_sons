/**
 * controls.js
 * -----------------------------------------------------------------------------
 * Traduz entradas do usuário (botões, pedais, teclado) em eventos de alto nível.
 *
 * Layout estilo pad: MOTOR / AUTO em cima; pedais FREIO e ACELERAR (segurar) e
 * as setas SOBE/DESCE embaixo. Não conhece o motor nem o áudio — só dispara
 * callbacks; o app decide o que fazer.
 * -----------------------------------------------------------------------------
 */

export class Controls {
    /**
     * @param {Object} el        - elementos do DOM
     * @param {Object} callbacks - { onTogglePower, onToggleEngine, onToggleAuto,
     *                               onShiftUp, onShiftDown, onThrottle, onBrake }
     */
    constructor(el, callbacks) {
        this.el = el;
        this.cb = callbacks;
        this._engineLoading = false;

        this._wireButtons();
        this._wirePedals();
        this._wireKeyboard();
    }

    /* ---------------------- botões discretos ---------------------- */
    _wireButtons() {
        this.el.displaySwitch.addEventListener('click', () => this.cb.onTogglePower());
        this.el.engine.addEventListener('click', () => this.cb.onToggleEngine());
        this.el.auto.addEventListener('click', () => this.cb.onToggleAuto());
        this.el.up.addEventListener('click', () => this.cb.onShiftUp());
        this.el.down.addEventListener('click', () => this.cb.onShiftDown());
    }

    /* ---------------------- pedais (segurar) ---------------------- */
    _wirePedals() {
        this._holdButton(this.el.gas,   (on) => this._gas(on));
        this._holdButton(this.el.brake, (on) => this._brake(on));
    }

    /** Liga um botão "segurar": pressiona = ativo, solta/sai = inativo. */
    _holdButton(btn, setActive) {
        const press = (e) => { e.preventDefault(); setActive(true); };
        const release = () => setActive(false);
        btn.addEventListener('pointerdown', press);
        btn.addEventListener('pointerup', release);
        btn.addEventListener('pointerleave', release);
        btn.addEventListener('pointercancel', release);
    }

    /** Acelerador (pedal/tecla): aciona o callback e acende o pedal. */
    _gas(on) {
        this.cb.onThrottle(on ? 1 : 0);
        this.el.gas.classList.toggle('is-active', on);
    }

    /** Freio/desacelerador (pedal/tecla): aciona o callback e acende o pedal. */
    _brake(on) {
        this.cb.onBrake(on ? 1 : 0);
        this.el.brake.classList.toggle('is-active', on);
    }

    /* ---------------------- teclado ---------------------- */
    _wireKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            switch (e.code) {
                case 'ArrowUp':    e.preventDefault(); this._gas(true);   break;
                case 'ArrowDown':  e.preventDefault(); this._brake(true); break;
                case 'ArrowRight': e.preventDefault(); this.cb.onShiftUp();   break;
                case 'ArrowLeft':  e.preventDefault(); this.cb.onShiftDown(); break;
                case 'KeyK': e.preventDefault(); this.cb.onToggleEngine(); break;
                case 'KeyT': e.preventDefault(); this.cb.onToggleAuto();   break;
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowUp')        this._gas(false);
            else if (e.code === 'ArrowDown') this._brake(false);
        });
    }

    /* ---------------------- estado dos controles ---------------------- */

    /** Habilita a chave DISPLAY (após o pré-carregamento dos áudios). */
    setDisplayReady(ready) {
        this.el.displaySwitch.disabled = !ready;
    }

    /** MOTOR em "carregando" (bomba escorvando): pulsa e trava. */
    setEngineLoading(loading) {
        this._engineLoading = loading;
        this.el.engine.classList.toggle('btn--loading', loading);
        this.el.engine.disabled = loading;
    }

    /**
     * Reflete o estado do sistema nos controles.
     * @param {boolean} powered - chave DISPLAY ligada
     * @param {boolean} running - motor em funcionamento
     */
    setState(powered, running) {
        this.el.engine.disabled = !powered || this._engineLoading;
        this.el.engine.classList.toggle('is-active', running); // aceso quando ligado
        this.el.auto.disabled = !powered;                      // pode pré-selecionar
        this.el.up.disabled = !running;
        this.el.down.disabled = !running;
        this.el.brake.disabled = !running;
        this.el.gas.disabled = !running;

        this.el.displaySwitch.setAttribute('aria-pressed', String(powered));

        if (!running) { this._gas(false); this._brake(false); }
    }
}
