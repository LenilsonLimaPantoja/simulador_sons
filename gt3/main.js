/**
 * main.js
 * -----------------------------------------------------------------------------
 * Ponto de entrada da aplicação (bootstrap).
 *
 * Responsabilidade única: ligar o DOM à aplicação e compor os subsistemas.
 * Fluxo:
 *   1. A tela principal já aparece, com o painel APAGADO.
 *   2. A chave DISPLAY liga o sistema: desbloqueia o áudio, toca o clique da
 *      chave (display.wav), carrega os assets e acende o painel + controles.
 *      Depois, ela funciona como um interruptor liga/desliga do painel.
 *   3. O MOTOR é ligado à parte, pelo botão LIGA/DESLIGA (ignição).
 *
 * Toda a coordenação e o laço de simulação vivem em Vehicle (vehicle.js).
 * -----------------------------------------------------------------------------
 */

import { AudioEngine, EngineSound } from './js/audioEngine.js';
import { Engine, ENGINE_CONFIG } from './js/engine.js';
import { Gearbox } from './js/gearbox.js';
import { Controls } from './js/controls.js';
import { Dashboard } from './js/dashboard.js';
import { Vehicle } from './js/vehicle.js';
import { delay } from './js/utils.js';

// Referências de DOM resolvidas uma vez.
const els = {
  stage: document.getElementById('stage'),
  dashboard: document.getElementById('dashboard'),
  pad: document.getElementById('pad'),
  displaySwitch: document.getElementById('display-switch'),
  throttleButton: document.getElementById('throttle-button'),
  brakeButton: document.getElementById('brake-button'),
  gearUpButton: document.getElementById('gearup-button'),
  gearDownButton: document.getElementById('geardown-button'),
  ignButton: document.getElementById('ign-button'),
  autoButton: document.getElementById('auto-button'),
};

// ---------------------------------------------------------------------------
// Composição dos subsistemas (sem globais além destas instâncias de sessão).
// ---------------------------------------------------------------------------
const audio = new AudioEngine();
const engine = new Engine();
const gearbox = new Gearbox();
const engineSound = new EngineSound(audio);
const controls = new Controls();
const dashboard = new Dashboard(els.dashboard, ENGINE_CONFIG);

/** Orquestrador. Criado no primeiro "power on". */
let vehicle = null;

/** Sistema já inicializado (assets carregados + veículo criado)? */
let booted = false;

/** Estado atual do display (aceso/apagado). */
let displayOn = false;

/** Evita cliques concorrentes durante o carregamento. */
let busy = false;

/**
 * Handler da chave DISPLAY: liga/desliga do sistema.
 */
function handleDisplaySwitch() {
  if (busy) return;
  if (displayOn) powerOff();
  else powerOn();
}

/**
 * Sequência de LIGAR: clique da chave, acende o painel, escorva a bomba por no
 * mínimo 3 s (mostrando "CARREGANDO…" e com os botões desabilitados) e, ao
 * terminar (na 1ª vez também carrega os áudios), libera os controles.
 */
async function powerOn() {
  busy = true;
  try {
    await audio.unlock(); // gesto -> retoma o contexto (já criado no pré-carregamento)

    await audio.loadOne('display'); // já em cache (pré-carregado)
    audio.playOneShot('display');
    setDisplay(true);
    setPadEnabled(false);
    els.ignButton.textContent = 'CARREGANDO';

    // Pequena pausa entre o clique da chave e a bomba (como num carro real).
    await delay(180);

    // Escorva da bomba de combustível (efeito de "startup").
    await audio.loadOne('fuel_pump');
    const pump = audio.playOneShot('fuel_pump');

    // Bomba por no mínimo 1,3 s (e espera o áudio, se ainda estiver carregando).
    await Promise.all([audio.loadAll(), delay(1300)]);

    fadeOutOneShot(pump); // pronto -> a bomba some

    // Na primeira vez, compõe o veículo e inicia o laço (motor DESLIGADO).
    if (!booted) {
      vehicle = new Vehicle({ engine, gearbox, engineSound, dashboard, controls });
      wireUiButtons(vehicle);
      vehicle.start();
      booted = true;
    }

    els.ignButton.textContent = 'MOTOR';
    setPadEnabled(true);
    setDrivingEnabled(false); // dirigir só depois de ligar o motor
  } catch (err) {
    console.error('[main] Falha ao ligar o sistema:', err);
    els.ignButton.textContent = 'ERRO';
  } finally {
    busy = false;
  }
}

/**
 * Sequência de DESLIGAR: clique da chave, apaga o painel, desabilita os botões
 * e desliga o motor (se estiver ligado).
 */
function powerOff() {
  audio.playOneShot('display');
  setDisplay(false);
  setPadEnabled(false);
  if (vehicle) vehicle.powerDown(); // desliga o motor e zera velocidade/RPM
}

/**
 * Acende/apaga o painel e reflete no visual da chave.
 * @param {boolean} on
 */
function setDisplay(on) {
  displayOn = on;
  dashboard.setPower(on);
  els.displaySwitch.classList.toggle('is-on', on);
  els.displaySwitch.setAttribute('aria-pressed', String(on));
}

/**
 * Habilita/desabilita o painel de controles (pad).
 * @param {boolean} on
 */
function setPadEnabled(on) {
  els.pad.classList.toggle('is-disabled', !on);
}

/**
 * Habilita/desabilita os botões de DIRIGIR (freio, marchas, acelerador).
 * Como no F1: só ficam ativos depois de LIGAR o motor. MOTOR e AUTO seguem
 * ativos com o painel ligado (para poder dar a partida e trocar o modo).
 * @param {boolean} on
 */
function setDrivingEnabled(on) {
  [els.brakeButton, els.gearUpButton, els.gearDownButton, els.throttleButton]
    .forEach((b) => b.classList.toggle('is-locked', !on));
}

/**
 * Conecta o painel de controle na tela às mesmas entradas do teclado, usando
 * Pointer Events (mouse e toque unificados). O teclado continua em paralelo.
 * @param {Vehicle} veh
 */
function wireUiButtons(veh) {
  // Pedais "segurar" (acelerador / freio): pressione-e-segure.
  bindHold(els.throttleButton, (on) => controls.setThrottle(on ? 1 : 0));
  bindHold(els.brakeButton, (on) => controls.setBrake(on ? 1 : 0));

  // Ações discretas (toque único).
  bindTap(els.gearUpButton, () => controls.uiShiftUp());
  bindTap(els.gearDownButton, () => controls.uiShiftDown());
  bindTap(els.ignButton, () => controls.uiIgnition());
  bindTap(els.autoButton, () => controls.uiToggleAuto());

  // Reflete o estado do automático no rótulo/estilo do botão.
  veh.onAutoChange = (on) => {
    els.autoButton.textContent = `AUTO: ${on ? 'ON' : 'OFF'}`;
    els.autoButton.classList.toggle('is-active', on);
  };
  // Sincroniza o botão com o estado inicial (automático já começa ligado).
  veh.onAutoChange(veh.isAuto);

  // Libera/trava os pedais e marchas conforme o motor liga/desliga (como no F1).
  veh.onRunningChange = (running) => setDrivingEnabled(running);
}

/**
 * Liga um botão do tipo "segurar": chama onChange(true) ao pressionar e
 * onChange(false) ao soltar/cancelar/sair. Acende o botão enquanto pressionado.
 * @param {HTMLElement} btn
 * @param {(on: boolean) => void} onChange
 */
function bindHold(btn, onChange) {
  const down = (e) => {
    e.preventDefault();
    onChange(true);
    btn.classList.add('is-active');
  };
  const up = (e) => {
    e.preventDefault();
    onChange(false);
    btn.classList.remove('is-active');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Faz o fade-out e para um one-shot (ex.: a bomba de combustível ao terminar
 * o carregamento). Tolerante caso o som já tenha acabado sozinho.
 * @param {{ source: AudioBufferSourceNode, gain: GainNode } | null} handle
 * @param {number} [seconds=0.35]
 */
function fadeOutOneShot(handle, seconds = 0.35) {
  if (!handle) return;
  const t = audio.now;
  const g = handle.gain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + seconds);
  try {
    handle.source.stop(t + seconds + 0.02);
  } catch {
    /* já parado/terminado */
  }
}

/**
 * Liga um botão de toque único (ação discreta).
 * @param {HTMLElement} btn
 * @param {() => void} onTap
 */
function bindTap(btn, onTap) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    onTap();
  });
}

els.displaySwitch.addEventListener('click', handleDisplaySwitch);

// Pré-carrega TODOS os áudios em segundo plano assim que a página abre. O
// contexto é criado suspenso (decodifica sem gesto); a chave DISPLAY só precisa
// retomá-lo. Assim, ao ligar, o carregamento já costuma estar pronto.
try {
  audio.prepare();
  audio.loadAll().catch((e) => console.warn('[main] pré-carregamento falhou:', e));
} catch (e) {
  console.warn('[main] contexto adiado até o gesto do usuário:', e);
}
