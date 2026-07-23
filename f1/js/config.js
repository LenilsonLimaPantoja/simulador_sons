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
        basePath: 'audio/',
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
        display:         'display.ogg',
        fuel_pump_prime: 'fuel_pump_prime.ogg',
        ignition_on:     'ignition_on.ogg',
        engine_shutdown: 'engine_shutdown.ogg',
        rpm_idle:  'idle.ogg',
        rpm_6000:  'rpm_6000.ogg',
        rpm_8000:  'rpm_8000.ogg',
        rpm_10000: 'rpm_10000.ogg',
        rpm_12000: 'rpm_12000.ogg',
        rpm_14000: 'rpm_14000.ogg',
        rpm_16000: 'rpm_16000.ogg',
        rpm_17000: 'rpm_17000.ogg',
        rpm_18000: 'rpm_18000.ogg',
        gear_up:   'gear_up.ogg',
        gear_down: 'gear_down.ogg',
        gear_1_acceleration: 'gear_1_acceleration.ogg',
        gear_2_acceleration: 'gear_2_acceleration.ogg',
        gear_3_acceleration: 'gear_3_acceleration.ogg',
        gear_4_acceleration: 'gear_4_acceleration.ogg',
        gear_5_acceleration: 'gear_5_acceleration.ogg',
        gear_6_acceleration: 'gear_6_acceleration.ogg',
        gear_7_acceleration: 'gear_7_acceleration.ogg',
        gear_1_deceleration: 'gear_1_deceleration.ogg',
        gear_2_deceleration: 'gear_2_deceleration.ogg',
        gear_3_deceleration: 'gear_3_deceleration.ogg',
        gear_4_deceleration: 'gear_4_deceleration.ogg',
        gear_5_deceleration: 'gear_5_deceleration.ogg',
        gear_6_deceleration: 'gear_6_deceleration.ogg',
        gear_7_deceleration: 'gear_7_deceleration.ogg',
        rev_limiter_loop: 'rev_limiter_loop.ogg',
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
        background: 'img/f1.png',
        logo:       'img/logo.png',
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
