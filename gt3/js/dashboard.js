/**
 * dashboard.js — GT3 Screamer
 * -----------------------------------------------------------------------------
 * Painel digital em estilo TACÔMETRO DE ARCO: um arco de RPM (SVG) que preenche
 * e muda de cor (verde → amarelo → vermelho) com brilho, a marcha em destaque no
 * centro, velocidade, RPM e telltales (LMT/REV) na base.
 *
 * Responsabilidade única: apresentação. Recebe números/flags em update() e
 * reflete na tela. Todo o DOM é criado UMA vez em _build(); em update() só
 * mudamos atributos/texto/classes — nada de recriar elementos por frame.
 * -----------------------------------------------------------------------------
 */

import { clamp } from './utils.js';

/** Geometria e configuração do arco. @type {Readonly<object>} */
const DASH_CONFIG = Object.freeze({
  VIEW: 300, // viewBox quadrado
  CX: 150,
  CY: 150,
  R: 122, // raio do arco
  STROKE: 16, // espessura
  ARC_START: 225, // ângulo inicial (base-esquerda), 0 = topo, cresce horário
  ARC_SWEEP: 270, // varredura total (gap de 90° na base)
  PATH_LEN: 1000, // pathLength normalizado (facilita o dasharray)
  // Zonas de cor por fração do RPM em relação à redline.
  ZONE_GREEN: 0.62,
  ZONE_YELLOW: 0.86,
});

/**
 * Converte ângulo (graus, 0 = topo, horário) em coordenada cartesiana no SVG.
 * @returns {[number, number]}
 */
function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/**
 * Gera o path de um arco (do ângulo inicial varrendo `sweep` graus, horário).
 * @returns {string}
 */
function arcPath(cx, cy, r, startAngle, sweep) {
  const [sx, sy] = polar(cx, cy, r, startAngle);
  const [ex, ey] = polar(cx, cy, r, startAngle + sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Cria um elemento SVG com atributos. */
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export class Dashboard {
  /**
   * @param {HTMLElement} container
   * @param {object} engineCfg  Precisa de IDLE_RPM, REDLINE_RPM, MAX_RPM.
   */
  constructor(container, engineCfg) {
    this._root = container;
    this._cfg = engineCfg;
    this._el = {};
    this._build();
  }

  /** @private */
  _build() {
    const c = DASH_CONFIG;
    this._root.innerHTML = '';
    this._root.classList.add('dash');
    this._root.classList.add('is-off'); // começa apagado até a chave DISPLAY

    // --- Tacômetro (arco SVG + conteúdo central) ---
    const gauge = document.createElement('div');
    gauge.className = 'gauge';

    const s = svg('svg', {
      class: 'gauge__svg',
      viewBox: `0 0 ${c.VIEW} ${c.VIEW}`,
    });

    const fullPath = arcPath(c.CX, c.CY, c.R, c.ARC_START, c.ARC_SWEEP);
    const redlineFrac = clamp(this._cfg.REDLINE_RPM / this._cfg.MAX_RPM, 0, 1);

    // Trilho de fundo (faint).
    s.appendChild(
      svg('path', {
        class: 'gauge__track',
        d: fullPath,
        fill: 'none',
        'stroke-width': c.STROKE,
        'stroke-linecap': 'round',
      }),
    );

    // Zona da redline (segmento vermelho fixo e discreto no fim do arco).
    const redStart = c.ARC_START + c.ARC_SWEEP * redlineFrac;
    s.appendChild(
      svg('path', {
        class: 'gauge__redzone',
        d: arcPath(c.CX, c.CY, c.R, redStart, c.ARC_SWEEP * (1 - redlineFrac)),
        fill: 'none',
        'stroke-width': c.STROKE,
        'stroke-linecap': 'round',
      }),
    );

    // Progresso (preenche com o RPM; cor e brilho via variável CSS).
    const progress = svg('path', {
      class: 'gauge__progress',
      d: fullPath,
      fill: 'none',
      'stroke-width': c.STROKE,
      'stroke-linecap': 'round',
      pathLength: c.PATH_LEN,
      'stroke-dasharray': `0 ${c.PATH_LEN}`,
    });
    s.appendChild(progress);
    this._el.progress = progress;

    gauge.appendChild(s);

    // --- Conteúdo central: VELOCIDADE em destaque ---
    const center = document.createElement('div');
    center.className = 'gauge__center';
    center.innerHTML = `
      <div class="gauge__speed-big"><span id="dash-speed">0</span></div>
      <div class="gauge__unit">KM/H</div>
    `;
    gauge.appendChild(center);

    // --- RPM à esquerda, no meio (equilibra a marcha) ---
    const rpmBox = document.createElement('div');
    rpmBox.className = 'gauge__rpm';
    rpmBox.innerHTML = `<span id="dash-rpm">0</span><em>RPM</em>`;
    gauge.appendChild(rpmBox);

    // --- Marcha (só o número), embaixo à direita ---
    const gearBox = document.createElement('div');
    gearBox.className = 'gauge__gearbox';
    gearBox.innerHTML = `<div class="gauge__gear" id="dash-gear">N</div>`;
    gauge.appendChild(gearBox);

    // --- Telltales (base) ---
    const status = document.createElement('div');
    status.className = 'gauge__status';
    const pills = [
      { id: 'dash-abs', text: 'ABS' },
      { id: 'dash-tc', text: 'TC' },
      { id: 'dash-lmt', text: 'LMT' },
      { id: 'dash-rev', text: 'REV' },
    ];
    for (const p of pills) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = p.text;
      if (p.id) pill.id = p.id;
      status.appendChild(pill);
    }

    this._root.append(gauge, status);

    // Referências para update().
    this._el.gear = gauge.querySelector('#dash-gear');
    this._el.speed = gauge.querySelector('#dash-speed');
    this._el.rpm = gauge.querySelector('#dash-rpm');
    this._el.gauge = gauge;
    this._el.abs = status.querySelector('#dash-abs');
    this._el.tc = status.querySelector('#dash-tc');
    this._el.lmt = status.querySelector('#dash-lmt');
    this._el.rev = status.querySelector('#dash-rev');
  }

  /**
   * Liga/apaga a tela do painel (efeito visual da chave DISPLAY).
   * @param {boolean} on
   */
  setPower(on) {
    this._root.classList.toggle('is-off', !on);
  }

  /**
   * Atualiza o painel. Chamar a cada frame.
   * @param {object} s
   * @param {number}  s.rpm
   * @param {number}  s.speedKmh
   * @param {number}  s.gear      0 = neutro
   * @param {boolean} s.atRedline
   * @param {boolean} s.limiting
   * @param {boolean} [s.braking]  Freando (acende ABS).
   * @param {boolean} [s.tc]       Controle de tração atuando (acende TC).
   */
  update({ rpm, speedKmh, gear, atRedline, limiting, braking, tc }) {
    const cfg = this._cfg;
    const c = DASH_CONFIG;

    // Preenchimento do arco (0..MAX).
    const frac = clamp(rpm / cfg.MAX_RPM, 0, 1);
    this._el.progress.setAttribute(
      'stroke-dasharray',
      `${(frac * c.PATH_LEN).toFixed(1)} ${c.PATH_LEN}`,
    );

    // Cor/brilho conforme a rotação em relação à redline.
    const t = clamp(rpm / cfg.REDLINE_RPM, 0, 1.2);
    let color = 'var(--ok)';
    if (t >= c.ZONE_YELLOW) color = 'var(--accent)';
    else if (t >= c.ZONE_GREEN) color = 'var(--warn)';
    this._el.progress.style.setProperty('--rev', color);

    // Números.
    this._el.rpm.textContent = Math.round(rpm).toLocaleString('pt-BR');
    this._el.speed.textContent = Math.round(speedKmh).toString();
    this._el.gear.textContent = gear === 0 ? 'N' : String(gear);

    // Estados.
    this._el.gauge.classList.toggle('is-redline', atRedline);
    this._el.gauge.classList.toggle('is-limiter', limiting);
    this._el.abs.classList.toggle('is-on', !!braking);
    this._el.tc.classList.toggle('is-on', !!tc);
    this._el.lmt.classList.toggle('is-on', limiting);
    this._el.rev.classList.toggle('is-on', atRedline);
  }
}
