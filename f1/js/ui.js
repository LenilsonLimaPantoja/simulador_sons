/**
 * ui.js
 * -----------------------------------------------------------------------------
 * Renderiza o painel: tacômetro (canvas), RPM, marcha, velocidade, acelerador
 * e status. Recebe o estado pronto e apenas desenha — nenhuma lógica de motor.
 * -----------------------------------------------------------------------------
 */

const deg2rad = (d) => (d * Math.PI) / 180;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class UI {
    constructor(el) {
        this.el = el;
        this.config = null;
        this.tachCfg = null;

        this._dpr = window.devicePixelRatio || 1;
        this._size = el.tach.width; // largura lógica definida no HTML (520)

        // Duas camadas: fundo (arcos/marcações/miolo) e ponteiro (por cima).
        this.ctx = this._setupCanvas(el.tach);
        this.ctxNeedle = this._setupCanvas(el.tachNeedle);
    }

    /** Define o perfil do veículo (cores/zonas/faixa do tacômetro). */
    setConfig(config) {
        this.config = config;
        this.tachCfg = config.ui.tach;
    }

    /** Ajusta um canvas para telas de alta densidade e devolve o contexto. */
    _setupCanvas(canvas) {
        const dpr = this._dpr;
        const size = this._size;
        canvas.width = size * dpr;   // buffer em alta densidade
        canvas.height = size * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);         // desenha em coordenadas lógicas (0..size)
        return ctx;
    }

    /** Atualiza todos os elementos a partir do estado combinado. */
    render(state) {
        if (!this.config) return;
        // O mostrador usa o displayRpm (sobe devagar na partida); o áudio usa o real.
        const shownRpm = state.displayRpm ?? state.rpm;
        this._drawTachometer(shownRpm);
        this.el.rpmValue.textContent = Math.round(shownRpm).toLocaleString('pt-BR');
        this.el.speedValue.textContent = Math.round(state.speed);
        this.el.gearValue.textContent = (state.running && state.gear > 0) ? state.gear : 'N';
    }

    /* ---------------------- tacômetro (canvas) ---------------------- */
    _drawTachometer(rpm) {
        const { ctx, _size } = this;
        const cfg = this.tachCfg;
        const cx = _size / 2;
        const cy = _size / 2;
        const r = _size / 2 - 24;

        const maxRPM = this.config.engine.maxRPM;
        const a0 = deg2rad(cfg.startAngle);
        const a1 = deg2rad(cfg.endAngle);

        ctx.clearRect(0, 0, _size, _size);

        // Trilho de fundo
        this._arc(cx, cy, r, a0, a1, cfg.colors.track, 22);

        // Zonas de progresso coloridas
        const rpmAngle = (v) => a0 + (clamp(v, 0, maxRPM) / maxRPM) * (a1 - a0);
        const cur = rpmAngle(rpm);
        const warn = rpmAngle(cfg.warnRPM);
        const danger = rpmAngle(cfg.dangerRPM);

        if (cur > a0) {
            this._arc(cx, cy, r, a0, Math.min(cur, warn), cfg.colors.normal, 22);
        }
        if (cur > warn) {
            this._arc(cx, cy, r, warn, Math.min(cur, danger), cfg.colors.warn, 22);
        }
        if (cur > danger) {
            this._arc(cx, cy, r, danger, cur, cfg.colors.danger, 22);
        }

        // Marcações de RPM (x1000)
        this._drawTicks(cx, cy, r, a0, a1, maxRPM);

        // --- Camada do PONTEIRO (canvas separado, por cima dos números) ---
        const nctx = this.ctxNeedle;
        nctx.clearRect(0, 0, _size, _size);

        // Ponteiro
        this._drawNeedle(nctx, cx, cy, r - 6, cur, cfg.colors.needle);

        // Miolo (junto do ponteiro, também por cima)
        nctx.beginPath();
        nctx.arc(cx, cy, 14, 0, Math.PI * 2);
        nctx.fillStyle = '#0c0f16';
        nctx.fill();
        nctx.lineWidth = 3;
        nctx.strokeStyle = cfg.colors.needle;
        nctx.stroke();
    }

    _arc(cx, cy, r, from, to, color, width) {
        const { ctx } = this;
        ctx.beginPath();
        ctx.arc(cx, cy, r, from, to);
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    _drawTicks(cx, cy, r, a0, a1, maxRPM) {
        const { ctx } = this;
        const step = this.tachCfg.tickStep || 1000; // rpm entre marcações
        const unit = this.tachCfg.tickUnit || 1000; // divisor do rótulo
        const count = Math.floor(maxRPM / step);
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= count; i += 2) {
            const rpmVal = i * step;
            const ang = a0 + (rpmVal / maxRPM) * (a1 - a0);
            const inner = r - 30;
            const lx = cx + Math.cos(ang) * inner;
            const ly = cy + Math.sin(ang) * inner;
            const isRed = rpmVal >= this.tachCfg.dangerRPM;
            ctx.fillStyle = isRed ? this.tachCfg.colors.danger : '#8a93a6';
            ctx.fillText(String(Math.round(rpmVal / unit)), lx, ly);
        }
    }

    _drawNeedle(ctx, cx, cy, len, angle, color) {
        const tipX = cx + Math.cos(angle) * len;
        const tipY = cy + Math.sin(angle) * len;
        const tailX = cx - Math.cos(angle) * 26;
        const tailY = cy - Math.sin(angle) * 26;

        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tipX, tipY);
        ctx.lineWidth = 5;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }
}
