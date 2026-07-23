# F1 V8 Engine Simulator (2009–2013)

Simulador **sonoro** de motor de Fórmula 1 V8, em HTML + CSS + JavaScript puro
(Web Audio API). Foco em reproduzir fielmente o *comportamento sonoro* — não a
física real.

## Como rodar

Os módulos ES6 e o carregamento dos `.wav` exigem um **servidor HTTP**
(não funciona abrindo o `index.html` direto via `file://`).

```bash
# a partir da pasta do projeto:
python -m http.server 8000
# depois abra http://localhost:8000
```

Ou use a extensão **Live Server** do VS Code.

## Uso

- **LIGAR** (ou `Enter`): sequência de partida automática → idle.
- **Acelerador**: slider analógico ou `W` / `↑`.
- **Subir marcha**: `D` / `→` · **Reduzir**: `A` / `←` (com blip automático).
- **DESLIGAR** (ou `Esc`): som de shutdown e para tudo.

## Arquitetura

| Arquivo | Responsabilidade |
|---|---|
| `js/config.js` | **Toda** a configuração (RPM, marchas, volumes, manifesto de áudio). |
| `js/audioEngine.js` | Web Audio API: buffers, one-shots, loops e mixagem (RPM/gear/limitador). |
| `js/engine.js` | Dinâmica de RPM (acelerador, freio-motor, limitador). |
| `js/gearbox.js` | Lógica das 7 marchas e fator de RPM nas trocas. |
| `js/vehicle.js` | Velocidade derivada de RPM + marcha. |
| `js/controls.js` | Entrada (botões, slider, teclado) → eventos. |
| `js/ui.js` | Tacômetro (canvas) e leitura digital. |
| `js/app.js` | Orquestra tudo e roda o loop principal. |

## Adaptar para outro veículo (GT3, NASCAR, MotoGP, Rally…)

1. Substitua os arquivos em `assets/audio/` (mantendo os nomes lógicos do
   manifesto, ou ajustando o mapeamento em `config.js`).
2. Ajuste os valores em `js/config.js` (RPM, `gearRatios`, `gearSpeeds`,
   `rpmLayers`, `volumes`, `pitchRange`, etc.).

Nenhum outro arquivo precisa ser alterado — a arquitetura é reutilizável.

## Observações sobre os áudios

- O idle usa `idle.wav` (mapeado como `rpm_idle` no manifesto).
- `starter.wav` é **opcional**: se o arquivo não existir, a etapa é ignorada
  com um aviso no console e a partida continua normalmente.
