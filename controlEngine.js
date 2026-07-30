/**
 * controlEngine.js
 *
 * This module is the decision-making heart of the greenhouse.
 * Based on the live sensor readings and the currently selected crop
 * profile, it determines the state of the relays (fan, heater, water pump).
 *
 * It uses "hysteresis" logic so relays don't rapidly flip on/off
 * (e.g. the fan won't switch on and off repeatedly right at the exact
 * threshold temperature - there's a safe buffer between turning on and off).
 */

// Hysteresis (safety buffer) amount for each parameter - adjustable
const HYSTERESIS = {
  temp: 1.5,       // degrees Celsius
  humidity: 5,     // percent
  soilMoisture: 5, // percent
};

/**
 * @param {object} sensorData - latest sensor readings { temp, humidity, soilMoisture, lightLux, waterLevel }
 * @param {object} profile - the active crop profile
 * @param {object} previousRelayState - previous relay states (needed to maintain hysteresis)
 * @param {object} manualOverrides - user manual overrides { fan: true/false/null, heater: ..., pump: ... }
 *        If a relay's value here is not null, the user is controlling it manually and the
 *        automatic engine won't interfere with it.
 * @returns {object} { relayState, reasons }
 */
function evaluate(sensorData, profile, previousRelayState = {}, manualOverrides = {}) {
  const relayState = { ...previousRelayState };
  const reasons = {};

  // ---------- Fan control (based on temperature) ----------
  if (manualOverrides.fan !== null && manualOverrides.fan !== undefined) {
    relayState.fan = manualOverrides.fan;
    reasons.fan = "Manually controlled by user";
  } else if (typeof sensorData.temp === "number") {
    const wasOn = !!previousRelayState.fan;
    if (!wasOn && sensorData.temp >= profile.tempMax) {
      relayState.fan = true;
      reasons.fan = `Temperature (${sensorData.temp}) reached the maximum allowed (${profile.tempMax})`;
    } else if (wasOn && sensorData.temp <= profile.tempMax - HYSTERESIS.temp) {
      relayState.fan = false;
      reasons.fan = `Temperature dropped back below the safe threshold (${(profile.tempMax - HYSTERESIS.temp).toFixed(1)})`;
    } else {
      relayState.fan = wasOn;
      reasons.fan = "No change";
    }
  }

  // ---------- Heater control (based on temperature) ----------
  if (manualOverrides.heater !== null && manualOverrides.heater !== undefined) {
    relayState.heater = manualOverrides.heater;
    reasons.heater = "Manually controlled by user";
  } else if (typeof sensorData.temp === "number") {
    const wasOn = !!previousRelayState.heater;
    if (!wasOn && sensorData.temp <= profile.tempMin) {
      relayState.heater = true;
      reasons.heater = `Temperature (${sensorData.temp}) reached the minimum allowed (${profile.tempMin})`;
    } else if (wasOn && sensorData.temp >= profile.tempMin + HYSTERESIS.temp) {
      relayState.heater = false;
      reasons.heater = `Temperature rose back above the safe threshold (${(profile.tempMin + HYSTERESIS.temp).toFixed(1)})`;
    } else {
      relayState.heater = wasOn;
      reasons.heater = "No change";
    }
  }

  // The fan and heater should never be on at the same time
  if (relayState.fan && relayState.heater) {
    relayState.heater = false;
    reasons.heater = "Kept off to avoid conflicting with the fan";
  }

  // ---------- Water pump control (based on soil moisture) ----------
  if (manualOverrides.pump !== null && manualOverrides.pump !== undefined) {
    relayState.pump = manualOverrides.pump;
    reasons.pump = "Manually controlled by user";
  } else if (typeof sensorData.soilMoisture === "number") {
    // Safety: don't turn the pump on if the water tank is low
    if (sensorData.waterLevel === "low") {
      relayState.pump = false;
      reasons.pump = "Water tank is low - pump kept off to prevent damage";
    } else {
      const wasOn = !!previousRelayState.pump;
      if (!wasOn && sensorData.soilMoisture <= profile.soilMoistureMin) {
        relayState.pump = true;
        reasons.pump = `Soil moisture (${sensorData.soilMoisture}) reached the minimum allowed (${profile.soilMoistureMin})`;
      } else if (wasOn && sensorData.soilMoisture >= profile.soilMoistureMax) {
        relayState.pump = false;
        reasons.pump = `Soil moisture reached the desired maximum (${profile.soilMoistureMax})`;
      } else {
        relayState.pump = wasOn;
        reasons.pump = "No change";
      }
    }
  } else {
    // Soil moisture sensor isn't connected yet - leave the pump as-is (no automatic decision)
    relayState.pump = previousRelayState.pump || false;
    reasons.pump = "Soil moisture sensor not connected - needs manual control or sensor installation";
  }

  return { relayState, reasons };
}

module.exports = { evaluate, HYSTERESIS };
