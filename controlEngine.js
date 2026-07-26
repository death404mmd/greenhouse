/**
 * controlEngine.js
 *
 * این ماژول قلب تصمیم‌گیری گلخونه‌ست.
 * بر اساس داده‌های لحظه‌ای سنسورها و پروفایل محصول انتخاب‌شده،
 * وضعیت رله‌ها (فن، بخاری، پمپ آب) رو تعیین می‌کنه.
 *
 * از منطق "هیسترزیس" استفاده می‌کنیم تا رله‌ها مدام روشن/خاموش نشن
 * (مثلاً فن دقیقاً روی ۲۷ درجه روشن نمی‌شه و روی ۲۷ درجه هم خاموش نمی‌شه،
 * بلکه یک فاصله ایمن بین روشن‌شدن و خاموش‌شدن وجود داره).
 */

// میزان هیسترزیس (فاصله ایمن) برای هر پارامتر - قابل تنظیم
const HYSTERESIS = {
  temp: 1.5,       // درجه سانتی‌گراد
  humidity: 5,     // درصد
  soilMoisture: 5, // درصد
};

/**
 * @param {object} sensorData - آخرین داده سنسورها { temp, humidity, soilMoisture, lightLux, waterLevel }
 * @param {object} profile - پروفایل فعال محصول
 * @param {object} previousRelayState - وضعیت قبلی رله‌ها (برای حفظ هیسترزیس)
 * @param {object} manualOverrides - override های دستی کاربر { fan: true/false/null, heater: ..., pump: ... }
 *        اگر مقدار یک رله در اینجا null نباشه، یعنی کاربر دستی کنترلش می‌کنه و موتور خودکار دخالت نمی‌کنه.
 * @returns {object} { relayState, reasons }
 */
function evaluate(sensorData, profile, previousRelayState = {}, manualOverrides = {}) {
  const relayState = { ...previousRelayState };
  const reasons = {};

  // ---------- کنترل فن (بر اساس دما) ----------
  if (manualOverrides.fan !== null && manualOverrides.fan !== undefined) {
    relayState.fan = manualOverrides.fan;
    reasons.fan = "کنترل دستی توسط کاربر";
  } else if (typeof sensorData.temp === "number") {
    const wasOn = !!previousRelayState.fan;
    if (!wasOn && sensorData.temp >= profile.tempMax) {
      relayState.fan = true;
      reasons.fan = `دما (${sensorData.temp}) به سقف مجاز (${profile.tempMax}) رسید`;
    } else if (wasOn && sensorData.temp <= profile.tempMax - HYSTERESIS.temp) {
      relayState.fan = false;
      reasons.fan = `دما به زیر آستانه ایمن (${(profile.tempMax - HYSTERESIS.temp).toFixed(1)}) رسید`;
    } else {
      relayState.fan = wasOn;
      reasons.fan = "بدون تغییر";
    }
  }

  // ---------- کنترل بخاری (بر اساس دما) ----------
  if (manualOverrides.heater !== null && manualOverrides.heater !== undefined) {
    relayState.heater = manualOverrides.heater;
    reasons.heater = "کنترل دستی توسط کاربر";
  } else if (typeof sensorData.temp === "number") {
    const wasOn = !!previousRelayState.heater;
    if (!wasOn && sensorData.temp <= profile.tempMin) {
      relayState.heater = true;
      reasons.heater = `دما (${sensorData.temp}) به کف مجاز (${profile.tempMin}) رسید`;
    } else if (wasOn && sensorData.temp >= profile.tempMin + HYSTERESIS.temp) {
      relayState.heater = false;
      reasons.heater = `دما به بالای آستانه ایمن (${(profile.tempMin + HYSTERESIS.temp).toFixed(1)}) رسید`;
    } else {
      relayState.heater = wasOn;
      reasons.heater = "بدون تغییر";
    }
  }

  // فن و بخاری هرگز نباید همزمان روشن باشن
  if (relayState.fan && relayState.heater) {
    relayState.heater = false;
    reasons.heater = "به‌خاطر تداخل با فن، خاموش نگه داشته شد";
  }

  // ---------- کنترل پمپ آب (بر اساس رطوبت خاک) ----------
  if (manualOverrides.pump !== null && manualOverrides.pump !== undefined) {
    relayState.pump = manualOverrides.pump;
    reasons.pump = "کنترل دستی توسط کاربر";
  } else if (typeof sensorData.soilMoisture === "number") {
    // ایمنی: اگه سطح آب مخزن پایینه، پمپ رو روشن نکن
    if (sensorData.waterLevel === "low") {
      relayState.pump = false;
      reasons.pump = "مخزن آب خالیه - پمپ برای جلوگیری از آسیب خاموش موند";
    } else {
      const wasOn = !!previousRelayState.pump;
      if (!wasOn && sensorData.soilMoisture <= profile.soilMoistureMin) {
        relayState.pump = true;
        reasons.pump = `رطوبت خاک (${sensorData.soilMoisture}) به کف مجاز (${profile.soilMoistureMin}) رسید`;
      } else if (wasOn && sensorData.soilMoisture >= profile.soilMoistureMax) {
        relayState.pump = false;
        reasons.pump = `رطوبت خاک به سقف مطلوب (${profile.soilMoistureMax}) رسید`;
      } else {
        relayState.pump = wasOn;
        reasons.pump = "بدون تغییر";
      }
    }
  } else {
    // سنسور رطوبت خاک هنوز وصل نشده - پمپ رو دستی نگه دار (بدون تصمیم خودکار)
    relayState.pump = previousRelayState.pump || false;
    reasons.pump = "سنسور رطوبت خاک متصل نیست - نیاز به کنترل دستی یا اتصال سنسور";
  }

  return { relayState, reasons };
}

module.exports = { evaluate, HYSTERESIS };
