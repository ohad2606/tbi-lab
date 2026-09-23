/**
 * Model-card registry: language-neutral model ids (as stored in project parameters) ->
 * documented device model cards. An unknown id is refused, never approximated.
 */

import { LED_TLHR5400, type DiodeModel } from './models.js';

export const MODEL_CARDS: Readonly<Record<string, DiodeModel>> = {
  'model.led.vishay_tlhr5400': LED_TLHR5400,
};

/**
 * Forward-current range over which each card is documented to be faithful to the real part
 * (models.ts: the TLHR5400 card is valid for 1 mA .. 20 mA; above it the missing series
 * resistance makes V_F too low). Outside it the solution is still the exact solution of the
 * model, but the product must say the model is being used beyond its documented range.
 */
export const MODEL_VALID_CURRENT_A: Readonly<Record<string, readonly [number, number]>> = {
  'model.led.vishay_tlhr5400': [1e-3, 20e-3],
};
