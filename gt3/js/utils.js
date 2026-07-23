/**
 * utils.js
 * -----------------------------------------------------------------------------
 * Funções matemáticas puras, sem estado e sem dependências.
 *
 * Responsabilidade única: fornecer os blocos de construção numéricos usados por
 * todo o simulador (suavização de RPM, crossfades de potência constante,
 * conversões de ganho, mapeamento de faixas). Nada aqui conhece Web Audio,
 * DOM ou o domínio "motor" — são apenas números entrando e saindo.
 *
 * Manter estas funções puras (mesma entrada => mesma saída, sem efeitos
 * colaterais) torna-as triviais de testar e reutilizar em qualquer módulo.
 * -----------------------------------------------------------------------------
 */

/**
 * Restringe um valor ao intervalo [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Interpolação linear entre a e b.
 * @param {number} a  Valor em t = 0.
 * @param {number} b  Valor em t = 1.
 * @param {number} t  Fator de interpolação (idealmente em [0, 1]).
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Inverso de lerp: dado um valor entre a e b, retorna o t correspondente.
 * Protegido contra divisão por zero (retorna 0 se a === b).
 * @param {number} a
 * @param {number} b
 * @param {number} value
 * @returns {number} Fator em [0, 1] (não fixado; use clamp se necessário).
 */
export function inverseLerp(a, b, value) {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

/**
 * Remapeia um valor de uma faixa de entrada para uma faixa de saída.
 * Por padrão o resultado é fixado à faixa de saída para evitar extrapolação.
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @param {boolean} [doClamp=true]
 * @returns {number}
 */
export function mapRange(value, inMin, inMax, outMin, outMax, doClamp = true) {
  const t = inverseLerp(inMin, inMax, value);
  const result = lerp(outMin, outMax, t);
  return doClamp ? clamp(result, Math.min(outMin, outMax), Math.max(outMin, outMax)) : result;
}

/**
 * Curva suave "smoothstep" (Hermite) em [0, 1].
 * Deriva zero nas extremidades => transições sem "quinas" perceptíveis.
 * @param {number} t
 * @returns {number}
 */
export function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Curva ainda mais suave (Perlin smootherstep): derivadas 1ª e 2ª nulas nas
 * extremidades. Útil quando queremos que o início/fim de uma transição sejam
 * absolutamente imperceptíveis.
 * @param {number} t
 * @returns {number}
 */
export function smootherstep(t) {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Aproximação exponencial independente de framerate.
 *
 * Move `current` em direção a `target` de forma assintótica. O parâmetro
 * `smoothTime` é o tempo aproximado (em segundos) para cobrir ~63% da distância
 * restante — é a "constante de tempo" (tau) do filtro de 1ª ordem.
 *
 * Como usa exp(-dt/tau), o resultado é estável para qualquer `dt` (não explode
 * em quedas de frame nem muda de comportamento conforme o FPS). É a base do
 * "RPM smoothing" e do "RPM filter" exigidos pelo motor.
 *
 * @param {number} current    Valor atual.
 * @param {number} target     Valor alvo.
 * @param {number} smoothTime Constante de tempo em segundos (> 0). Menor = mais rápido.
 * @param {number} dt         Delta de tempo do frame em segundos.
 * @returns {number} Novo valor aproximado.
 */
export function expApproach(current, target, smoothTime, dt) {
  if (smoothTime <= 0) return target;
  // Fator de mistura no intervalo (0, 1]; independe do framerate.
  const alpha = 1 - Math.exp(-dt / smoothTime);
  return current + (target - current) * alpha;
}

/**
 * Ganhos de crossfade de POTÊNCIA CONSTANTE (equal-power).
 *
 * Ao misturar dois sinais de áudio não correlacionados, um fade linear causa
 * uma queda audível de volume no meio (–3 dB à –6 dB). A lei de potência
 * constante usa seno/cosseno de modo que gainA² + gainB² = 1 em todo o
 * percurso, mantendo o volume percebido estável — essencial para que as
 * transições entre camadas de RPM sejam imperceptíveis.
 *
 * @param {number} t  Posição do crossfade em [0, 1]. 0 => só A, 1 => só B.
 * @returns {{ a: number, b: number }} Ganhos para as fontes A e B.
 */
export function equalPowerCrossfade(t) {
  t = clamp(t, 0, 1);
  const angle = t * (Math.PI / 2); // 0..90°
  return {
    a: Math.cos(angle),
    b: Math.sin(angle),
  };
}

/**
 * Converte decibéis para ganho linear (amplitude).
 * 0 dB => 1.0, -6 dB => ~0.5, -inf dB => 0.
 * @param {number} db
 * @returns {number}
 */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Converte ganho linear (amplitude) para decibéis.
 * Protegido contra log(0) fixando um piso muito baixo.
 * @param {number} gain
 * @returns {number}
 */
export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

/**
 * Promise que resolve após `ms` milissegundos.
 * Útil para sequências temporizadas (ex.: aguardar o starter terminar).
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
