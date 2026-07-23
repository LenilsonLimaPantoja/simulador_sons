/**
 * config.js — F1 V8 (perfil único deste app)
 * -----------------------------------------------------------------------------
 * Toda a configuração do simulador do F1 V8. Para outro veículo, use o app
 * correspondente (ex.: ../gt3). O lançador na raiz escolhe qual abrir.
 * -----------------------------------------------------------------------------
 */

export const CONFIG = {
    id: 'f1_v8',
    name: 'F1 V8',
    tagline: '2009 – 2013',

    soundProfile: 'gearLoops',
    sounds: {
        gearUp:      'gear_up',
        gearDown:    'gear_down',
        shutdown:    'engine_shutdown',
        limiterLoop: 'rev_limiter_loop',
    },

    engine: {
        idleRPM:    4500,
        maxRPM:     18000,
        redlineRPM: 17800,
        limiterRPM: 18000,
        accelerationRates: [8000, 6800, 5800, 4800, 4000, 3300, 2800],
        neutralAccel: 18000,
        engineBraking: 3200,
        internalDrag: 1500,
        throttleResponse: 0.10,
        brakeForce: 13000,
        startupFlare:      0.0,
        startupFlareDecay: 3.0,
        startupRevRate: 4000,
        startupRevDelay: 0.5,
    },

    gearbox: {
        gearCount: 7,
        gearRatios: [3.00, 2.40, 2.00, 1.72, 1.50, 1.34, 1.20],
        gearSpeeds: [85, 120, 158, 198, 240, 285, 335],
        shiftCooldown: 0.12,
        autoUpRPM: 17500,
        autoDownRPM: [0, 12000, 13000, 14000, 15000, 16000, 17000],
        autoShiftCooldown: 0.5,
        autoStartDefault: true,
    },

    vehicle: {
        coastDecel: 8,
        brakeDecel: 70,
    },

    audio: {
        basePath: 'assets/audio/f1_v8/',
        masterVolume: 0.9,
        volumes: {
            rpmLayers: 1.0,
            gearAccel: 0.48,
            gearDecel: 0.32,
            limiter:   0.85,
        },
        pitchRange: { min: 0.75, max: 1.35 },
        gearEngageRPM: 2000,
        crossfadeSmoothing: 0.03,
        crossfadeTime: 0.12,
        startupGap: 0.05,
        startupCrossfade: 0.30,
        shutdownFade: 0.55,
    },

    manifest: {
        display:         'display.wav',
        fuel_pump_prime: 'fuel_pump_prime.wav',
        ignition_on:     'ignition_on.wav',
        starter:         'starter.wav',
        engine_shutdown: 'engine_shutdown.wav',
        rpm_idle:  'idle.wav',
        rpm_6000:  'rpm_6000.wav',
        rpm_8000:  'rpm_8000.wav',
        rpm_10000: 'rpm_10000.wav',
        rpm_12000: 'rpm_12000.wav',
        rpm_14000: 'rpm_14000.wav',
        rpm_16000: 'rpm_16000.wav',
        rpm_17000: 'rpm_17000.wav',
        rpm_18000: 'rpm_18000.wav',
        gear_up:   'gear_up.wav',
        gear_down: 'gear_down.wav',
        gear_1_acceleration: 'gear_1_acceleration.wav',
        gear_2_acceleration: 'gear_2_acceleration.wav',
        gear_3_acceleration: 'gear_3_acceleration.wav',
        gear_4_acceleration: 'gear_4_acceleration.wav',
        gear_5_acceleration: 'gear_5_acceleration.wav',
        gear_6_acceleration: 'gear_6_acceleration.wav',
        gear_7_acceleration: 'gear_7_acceleration.wav',
        gear_1_deceleration: 'gear_1_deceleration.wav',
        gear_2_deceleration: 'gear_2_deceleration.wav',
        gear_3_deceleration: 'gear_3_deceleration.wav',
        gear_4_deceleration: 'gear_4_deceleration.wav',
        gear_5_deceleration: 'gear_5_deceleration.wav',
        gear_6_deceleration: 'gear_6_deceleration.wav',
        gear_7_deceleration: 'gear_7_deceleration.wav',
        rev_limiter_loop: 'rev_limiter_loop.wav',
    },

    rpmLayers: [
        { name: 'rpm_idle',  rpm: 4500  },
        { name: 'rpm_6000',  rpm: 6000  },
        { name: 'rpm_8000',  rpm: 8000  },
        { name: 'rpm_10000', rpm: 10000 },
        { name: 'rpm_12000', rpm: 12000 },
        { name: 'rpm_14000', rpm: 14000 },
        { name: 'rpm_16000', rpm: 16000 },
        { name: 'rpm_17000', rpm: 17000 },
        { name: 'rpm_18000', rpm: 18000 },
    ],

    power: {
        switchSound:   'display',
        primeSound:    'fuel_pump_prime',
        primeDelay:    0.18,
        primeDuration: 1.30,
        primeFade:     0.35,
    },
    startupSequence: ['ignition_on'],

    ui: {
        background: 'assets/images/fundo.png',
        logo:       'assets/images/logo.png',
        tach: {
            startAngle: 135,
            endAngle:   405,
            warnRPM:    15500,
            dangerRPM:  17800,
            tickStep:   1000,
            tickUnit:   1000,
            colors: {
                normal: '#e6e9ef',
                warn:   '#ffcc33',
                danger: '#ff2e3f',
                track:  '#1c2230',
                needle: '#ff2e3f',
            },
        },
    },
};
