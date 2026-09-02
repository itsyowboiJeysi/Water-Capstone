// backend/utils/waterQualityClassifier.js
// ═══════════════════════════════════════════════════════════════════════════════
// WATER QUALITY CLASSIFICATION & SCORING SYSTEM
// CSPC AgosTech — BSIT 4G 2026 — Gandaria
// Based on: WHO Guidelines for Drinking-water Quality (2017)
//           Philippine National Standards for Drinking Water / PNSDW (DOH 2017)
// ═══════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// PARAMETER TABLES
// Every range, classification, and remark from the PDF is stored here.
// Each entry: { range, classification, level, score, remark }
// ─────────────────────────────────────────────────────────────────────────────

const PH_TABLE = [
  {
    range:          "6.5 – 8.5",
    classification: "Safe",
    level:          "safe",
    score:          100,
    remark:         "Optimal range (WHO) [1]",
  },
  {
    range:          "6.0–6.4 & 8.6–9.0",
    classification: "Acceptable",
    level:          "acceptable",
    score:          75,
    remark:         "Allowable limits [1][2]",
  },
  {
    range:          "5.5–5.9 / 9.1–9.5",
    classification: "Warning",
    level:          "warning",
    score:          50,
    remark:         "Affects taste and corrosivity",
  },
  {
    range:          "<5.4 or >9.5",
    classification: "Unsafe",
    level:          "unsafe",
    score:          0,
    remark:         "Health risk; corrosive or strongly alkaline",
  },
];

const TURBIDITY_TABLE = [
  {
    range:          "0 – 1 NTU",
    classification: "Safe",
    level:          "safe",
    score:          100,
    remark:         "Ideal; WHO guideline target [1]",
  },
  {
    range:          "2 – 5 NTU",
    classification: "Acceptable",
    level:          "acceptable",
    score:          75,
    remark:         "Standard limit [2]",
  },
  {
    range:          "6 – 10 NTU",
    classification: "Warning",
    level:          "warning",
    score:          50,
    remark:         "Reduced water quality",
  },
  {
    range:          ">10 NTU",
    classification: "Unsafe",
    level:          "unsafe",
    score:          0,
    remark:         "Poor water quality; possible contamination",
  },
];

const TDS_TABLE = [
  {
    range:          "0 – 300 mg/L",
    classification: "Safe",
    level:          "safe",
    score:          100,
    remark:         "Excellent quality",
  },
  {
    range:          "301 – 500 mg/L",
    classification: "Acceptable",
    level:          "acceptable",
    score:          75,
    remark:         "Within WHO limit [1]",
  },
  {
    range:          "501 – 1000 mg/L",
    classification: "Warning",
    level:          "warning",
    score:          50,
    remark:         "Taste issues; elevated minerals",
  },
  {
    range:          ">1000 mg/L",
    classification: "Unsafe",
    level:          "unsafe",
    score:          0,
    remark:         "Exceeds WHO limit [1]",
  },
];

const AMMONIA_TABLE = [
  {
    range:          "< 0.5 mg/L",
    classification: "Safe",
    level:          "safe",
    score:          100,
    remark:         "Negligible; well below WHO aesthetic guideline [1]",
  },
  {
    range:          "0.51 – 1.0 mg/L",
    classification: "Acceptable",
    level:          "acceptable",
    score:          75,
    remark:         "Detectable but within tolerable range; monitor closely [1]",
  },
  {
    range:          "1.1 – 1.5 mg/L",
    classification: "Warning",
    level:          "warning",
    score:          50,
    remark:         "Approaching WHO aesthetic guideline limit of 1.5 mg/L [1]",
  },
  {
    range:          "> 1.5 mg/L",
    classification: "Critical",
    level:          "critical",
    score:          0,
    remark:         "Exceeds WHO aesthetic guideline; poses risk to water quality [1]",
  },
];

const TEMPERATURE_TABLE = [
  {
    range:          "20 – 25°C",
    classification: "Safe",
    level:          "safe",
    score:          100,
    remark:         "Optimal range",
  },
  {
    range:          "26 – 30°C",
    classification: "Acceptable",
    level:          "acceptable",
    score:          75,
    remark:         "Normal; within acceptable range",
  },
  {
    range:          "31 – 35°C",
    classification: "Warning",
    level:          "warning",
    score:          50,
    remark:         "Warm; may affect water quality",
  },
  {
    range:          ">35°C",
    classification: "Unsafe",
    level:          "unsafe",
    score:          0,
    remark:         "Promotes bacterial growth; reduces water safety",
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATIC UNSAFE CONDITIONS TABLE (from PDF)
// Every condition, override reason, and parameter exactly as documented.
// ─────────────────────────────────────────────────────────────────────────────

const OVERRIDE_RULES = [
  {
    param:        "ph",
    label:        "pH",
    condition:    (v) => v < 5.5 || v > 9.5,
    forceLevel:   "unsafe",
    conditionStr: "< 5.5 or > 9.5",
    reason:       "Indicates corrosive or alkaline water that may harm human health",
  },
  {
    param:        "turbidity",
    label:        "Turbidity",
    condition:    (v) => v > 10,
    forceLevel:   "unsafe",
    conditionStr: "> 10 NTU",
    reason:       "Suggests high suspended particles and possible microbial contamination",
  },
  {
    param:        "tds",
    label:        "Total Dissolved Solids (TDS)",
    condition:    (v) => v > 1000,
    forceLevel:   "unsafe",
    conditionStr: "> 1000 mg/L",
    reason:       "Indicates excessive dissolved substances affecting water quality",
  },
  {
    param:        "ammonia",
    label:        "Ammonia",
    condition:    (v) => v > 1.5,
    forceLevel:   "critical",
    conditionStr: "> 1.5 mg/L",
    reason:       "Toxic level; may indicate contamination from waste or sewage (exceeds WHO aesthetic guideline)",
  },
  {
    param:        "temperature",
    label:        "Temperature",
    condition:    (v) => v > 35,
    forceLevel:   "unsafe",
    conditionStr: "> 35°C",
    reason:       "Promotes bacterial growth and reduces water safety",
  },
];

const MULTI_PARAM_RULE = {
  param:        "multi_param_rule",
  label:        "Multiple Parameters",
  conditionStr: "Any combination of 2 or more WARNING + 1 UNSAFE",
  reason:       "Compounded risk increases overall hazard probability",
  forceLevel:   "unsafe",
};

const SENSOR_FAILURE_RULE = {
  param:        "sensor_failure",
  label:        "Sensor Failure / Invalid Data",
  conditionStr: "Null, NaN, or out-of-range readings",
  reason:       "System cannot guarantee reliability of output",
  forceLevel:   "critical",
};

const CONFLICT_RULE = {
  param:        "conflict_rule",
  label:        "Conflict Rule",
  conditionStr: "Safe score but any critical parameter detected",
  reason:       "Safety priority overrides computed score",
  forceLevel:   "unsafe",
};


// ─────────────────────────────────────────────────────────────────────────────
// COMBINED RESULTS TABLE (from PDF)
// Every condition, classification, allowed use, not recommended, and reason.
// ─────────────────────────────────────────────────────────────────────────────

const COMBINED_RESULTS_TABLE = [
  {
    condition:       "Only pH Unsafe",
    classification:  "Warning/Unsafe",
    allowed_use:     "Cleaning, washing",
    not_recommended: "Drinking",
    reason:          "Corrosive or irritating",
  },
  {
    condition:       "Only Turbidity High",
    classification:  "Unsafe",
    allowed_use:     "Flushing",
    not_recommended: "All human contact",
    reason:          "Possible bacteria",
  },
  {
    condition:       "Only TDS High",
    classification:  "Warning/Unsafe",
    allowed_use:     "Washing",
    not_recommended: "Cooking",
    reason:          "High dissolved solids",
  },
  {
    condition:       "Only Ammonia High",
    classification:  "Critical",
    allowed_use:     "None",
    not_recommended: "All uses",
    reason:          "Toxic compound",
  },
  {
    condition:       "Only Temperature High",
    classification:  "Warning",
    allowed_use:     "General use",
    not_recommended: "Drinking",
    reason:          "Bacterial growth",
  },
  {
    condition:       "Multiple Warnings",
    classification:  "Warning",
    allowed_use:     "Cleaning",
    not_recommended: "All uses",
    reason:          "Combined risk",
  },
  {
    condition:       "Any Unsafe",
    classification:  "Unsafe",
    allowed_use:     "Limited use",
    not_recommended: "All uses",
    reason:          "Safety concern",
  },
  {
    condition:       "Any Critical",
    classification:  "Critical",
    allowed_use:     "None",
    not_recommended: "All uses",
    reason:          "Severe hazard",
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// SCORE RANGE TABLE (from PDF)
// Every score bracket, safety classification, recommended use, and explanation.
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_RANGE_TABLE = [
  {
    range:           "90 – 100",
    min:             90,
    max:             100,
    classification:  "SAFE",
    label:           "Safe",
    color:           "#16A34A",
    recommended_use: "Handwashing, restroom use, classroom cleaning, laboratory experiments, campus ground maintenance",
    not_recommended: "Drinking directly without further treatment",
    explanation:     "All physical parameters within ideal WHO/PNSDW range. Safe for all non-intake school activities.",
    water_status:    "safe",
  },
  {
    range:           "75 – 89",
    min:             75,
    max:             89,
    classification:  "ACCEPTABLE",
    label:           "Acceptable",
    color:           "#84CC16",
    recommended_use: "Restroom flushing, mopping hallways and classrooms, watering school garden",
    not_recommended: "Use in laboratories or on skin; avoid direct contact",
    explanation:     "Minor deviations detected in one or more physical parameters. Suitable for indirect contact and utility use; avoid use in laboratories or on skin.",
    water_status:    "safe",
  },
  {
    range:           "50 – 74",
    min:             50,
    max:             74,
    classification:  "WARNING",
    label:           "Warning",
    color:           "#F59E0B",
    recommended_use: "Outdoor ground irrigation, flushing drains, washing outdoor walkways",
    not_recommended: "Any indoor or human contact use",
    explanation:     "Noticeable degradation in physical quality. Restrict to outdoor non-contact use only. Notify school facility management for inspection.",
    water_status:    "warning",
  },
  {
    range:           "25 – 49",
    min:             25,
    max:             49,
    classification:  "UNSAFE",
    label:           "Unsafe",
    color:           "#EF4444",
    recommended_use: "Toilet flushing only; all other uses suspended",
    not_recommended: "All human contact uses",
    explanation:     "Significant contamination in physical readings. Suspend all human contact use. Alert school administration and initiate water source inspection.",
    water_status:    "danger",
  },
  {
    range:           "0 – 24",
    min:             0,
    max:             24,
    classification:  "CRITICAL",
    label:           "Critical",
    color:           "#7C3AED",
    recommended_use: "No use permitted; shut off supply and report to authorities",
    not_recommended: "All uses — immediate shutdown required",
    explanation:     "Severe physical parameter violations. Immediately shut down water access across campus. Report to school admin and local health office.",
    water_status:    "danger",
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Per-parameter classification functions
// Each returns the full matching row from the table above, plus the raw value.
// ─────────────────────────────────────────────────────────────────────────────

function classifyPH(ph) {
  if (ph === null || ph === undefined || isNaN(ph)) {
    return { score: 0, level: "critical", classification: "Critical", range: "Invalid", remark: "Sensor failure or missing pH reading", table: PH_TABLE };
  }
  let row;
  if (ph >= 6.5 && ph <= 8.5)                              row = PH_TABLE[0];
  else if ((ph >= 6.0 && ph < 6.5) || (ph > 8.5 && ph <= 9.0)) row = PH_TABLE[1];
  else if ((ph >= 5.5 && ph < 6.0) || (ph > 9.0 && ph <= 9.5)) row = PH_TABLE[2];
  else                                                       row = PH_TABLE[3];
  return { ...row, value: ph, unit: "", table: PH_TABLE };
}

function classifyTurbidity(ntu) {
  if (ntu === null || ntu === undefined || isNaN(ntu)) {
    return { score: 0, level: "critical", classification: "Critical", range: "Invalid", remark: "Sensor failure or missing turbidity reading", table: TURBIDITY_TABLE };
  }
  let row;
  if (ntu <= 1)       row = TURBIDITY_TABLE[0];
  else if (ntu <= 5)  row = TURBIDITY_TABLE[1];
  else if (ntu <= 10) row = TURBIDITY_TABLE[2];
  else                row = TURBIDITY_TABLE[3];
  return { ...row, value: ntu, unit: "NTU", table: TURBIDITY_TABLE };
}

function classifyTDS(mgL) {
  if (mgL === null || mgL === undefined || isNaN(mgL)) {
    return { score: 0, level: "critical", classification: "Critical", range: "Invalid", remark: "Sensor failure or missing TDS reading", table: TDS_TABLE };
  }
  let row;
  if (mgL <= 300)       row = TDS_TABLE[0];
  else if (mgL <= 500)  row = TDS_TABLE[1];
  else if (mgL <= 1000) row = TDS_TABLE[2];
  else                  row = TDS_TABLE[3];
  return { ...row, value: mgL, unit: "mg/L", table: TDS_TABLE };
}

function classifyAmmonia(mgL) {
  if (mgL === null || mgL === undefined || isNaN(mgL)) {
    return { score: 0, level: "critical", classification: "Critical", range: "Invalid", remark: "Sensor failure or missing ammonia reading", table: AMMONIA_TABLE };
  }
  let row;
  if (mgL < 0.5)       row = AMMONIA_TABLE[0];
  else if (mgL <= 1.0) row = AMMONIA_TABLE[1];
  else if (mgL <= 1.5) row = AMMONIA_TABLE[2];
  else                 row = AMMONIA_TABLE[3];
  return { ...row, value: mgL, unit: "mg/L", table: AMMONIA_TABLE };
}

function classifyTemperature(celsius) {
  if (celsius === null || celsius === undefined || isNaN(celsius)) {
    return { score: 0, level: "critical", classification: "Critical", range: "Invalid", remark: "Sensor failure or missing temperature reading", table: TEMPERATURE_TABLE };
  }
  let row;
  if (celsius >= 20 && celsius <= 25)      row = TEMPERATURE_TABLE[0];
  else if (celsius >= 26 && celsius <= 30) row = TEMPERATURE_TABLE[1];
  else if (celsius >= 31 && celsius <= 35) row = TEMPERATURE_TABLE[2];
  else                                     row = TEMPERATURE_TABLE[3];
  return { ...row, value: celsius, unit: "°C", table: TEMPERATURE_TABLE };
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Weighted scoring formula
// Final Score = 0.20(SpH) + 0.20(STurbidity) + 0.20(STDS) + 0.20(STemp) + 0.20(SAmmonia)
// ─────────────────────────────────────────────────────────────────────────────

function computeWeightedScore({ ph, turbidity, tds, temperature, ammonia }) {
  return 0.20 * ph + 0.20 * turbidity + 0.20 * tds + 0.20 * temperature + 0.20 * ammonia;
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Look up the matching score-range row
// ─────────────────────────────────────────────────────────────────────────────

function getScoreRow(score) {
  return SCORE_RANGE_TABLE.find((r) => score >= r.min && score <= r.max) || SCORE_RANGE_TABLE[4];
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Determine which combined-results row best matches the current state
// (used for the "condition-specific" allowed/not-recommended guidance)
// ─────────────────────────────────────────────────────────────────────────────

function getConditionRow(perParam, finalClassification) {
  const levels = Object.values(perParam).map((p) => p.level);
  const hasAmmoniaCritical = perParam.ammonia.level === "critical";
  const hasUnsafe   = levels.some((l) => l === "unsafe");
  const hasCritical = levels.some((l) => l === "critical");
  const warnCount   = levels.filter((l) => l === "warning").length;

  // Match from most severe to least, exactly per PDF table
  if (hasCritical || hasAmmoniaCritical) return COMBINED_RESULTS_TABLE[7]; // Any Critical
  if (hasUnsafe)                          return COMBINED_RESULTS_TABLE[6]; // Any Unsafe

  // Single-parameter unsafe conditions
  if (perParam.ph.level === "unsafe")          return COMBINED_RESULTS_TABLE[0]; // Only pH Unsafe
  if (perParam.turbidity.level === "unsafe")   return COMBINED_RESULTS_TABLE[1]; // Only Turbidity High
  if (perParam.tds.level === "unsafe")         return COMBINED_RESULTS_TABLE[2]; // Only TDS High
  if (perParam.ammonia.level === "unsafe")     return COMBINED_RESULTS_TABLE[3]; // Only Ammonia High
  if (perParam.temperature.level === "unsafe") return COMBINED_RESULTS_TABLE[4]; // Only Temperature High

  if (warnCount >= 2) return COMBINED_RESULTS_TABLE[5]; // Multiple Warnings

  // Default — return the row matching overall classification
  return COMBINED_RESULTS_TABLE.find(
    (r) => r.classification.toUpperCase() === finalClassification
  ) || COMBINED_RESULTS_TABLE[5];
}


// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — classifyWaterQuality(readings)
//
// Input  : { ph_level, turbidity, tds, temperature, ammonia }
// Output : full classification object with every remark, reason, and guidance
//          from the PDF embedded directly in the response
// ─────────────────────────────────────────────────────────────────────────────

function classifyWaterQuality({ ph_level, turbidity, tds, temperature, ammonia }) {
  const readings = { ph: ph_level, turbidity, tds, temperature, ammonia };

  // ── Per-parameter results (with full remarks from tables) ─────────────────
  const perParam = {
    ph:          classifyPH(ph_level),
    turbidity:   classifyTurbidity(turbidity),
    tds:         classifyTDS(tds),
    temperature: classifyTemperature(temperature),
    ammonia:     classifyAmmonia(ammonia),
  };

  // ── Weighted score ─────────────────────────────────────────────────────────
  const rawScore  = computeWeightedScore({
    ph:          perParam.ph.score,
    turbidity:   perParam.turbidity.score,
    tds:         perParam.tds.score,
    temperature: perParam.temperature.score,
    ammonia:     perParam.ammonia.score,
  });
  let finalScore  = Math.round(rawScore);
  let forcedLevel = null;
  const triggered_overrides = [];

  // ── Automatic UNSAFE overrides (full reason attached) ─────────────────────
  for (const rule of OVERRIDE_RULES) {
    const val = readings[rule.param];
    if (val !== null && val !== undefined && !isNaN(val) && rule.condition(val)) {
      triggered_overrides.push({
        param:        rule.param,
        label:        rule.label,
        condition:    rule.conditionStr,
        forced_level: rule.forceLevel,
        reason:       rule.reason,
      });
      if (!forcedLevel || rule.forceLevel === "critical") {
        forcedLevel = rule.forceLevel;
      }
    }
  }

  // ── Sensor failure override ────────────────────────────────────────────────
  const hasSensorFailure = Object.values(readings).some(
    (v) => v === null || v === undefined || isNaN(v)
  );
  if (hasSensorFailure) {
    forcedLevel = "critical";
    triggered_overrides.push({
      param:        SENSOR_FAILURE_RULE.param,
      label:        SENSOR_FAILURE_RULE.label,
      condition:    SENSOR_FAILURE_RULE.conditionStr,
      forced_level: SENSOR_FAILURE_RULE.forceLevel,
      reason:       SENSOR_FAILURE_RULE.reason,
    });
  }

  // ── Multi-parameter combined rule ─────────────────────────────────────────
  const levels      = Object.values(perParam).map((p) => p.level);
  const warnCount   = levels.filter((l) => l === "warning").length;
  const unsafeCount = levels.filter((l) => l === "unsafe" || l === "critical").length;
  const multiParamTriggered = warnCount >= 2 && unsafeCount >= 1;
  if (multiParamTriggered && !forcedLevel) {
    forcedLevel = "unsafe";
    triggered_overrides.push({
      param:        MULTI_PARAM_RULE.param,
      label:        MULTI_PARAM_RULE.label,
      condition:    MULTI_PARAM_RULE.conditionStr,
      forced_level: MULTI_PARAM_RULE.forceLevel,
      reason:       MULTI_PARAM_RULE.reason,
    });
  }

  // ── Conflict rule: safe score but critical param ───────────────────────────
  const hasCriticalParam = levels.some((l) => l === "critical");
  if (hasCriticalParam && forcedLevel !== "critical") {
    triggered_overrides.push({
      param:        CONFLICT_RULE.param,
      label:        CONFLICT_RULE.label,
      condition:    CONFLICT_RULE.conditionStr,
      forced_level: CONFLICT_RULE.forceLevel,
      reason:       CONFLICT_RULE.reason,
    });
  }

  // ── Cap final score based on forced level ─────────────────────────────────
  if (forcedLevel === "critical") {
    finalScore = Math.min(finalScore, 24);
  } else if (forcedLevel === "unsafe") {
    finalScore = Math.min(finalScore, 49);
  }

  // ── Score-range lookup (full row with explanation) ─────────────────────────
  const scoreRow = getScoreRow(finalScore);

  // ── Condition-specific guidance lookup ────────────────────────────────────
  const conditionRow = getConditionRow(perParam, scoreRow.classification);

  // ── Strip the `table` array from each per_param before returning ──────────
  //    (it's large; consumers can import the table constants directly if needed)
  const perParamClean = {};
  for (const [key, val] of Object.entries(perParam)) {
    const { table: _omit, ...rest } = val;
    perParamClean[key] = rest;
  }

  return {
    // ── Core score & status ────────────────────────────────────────────────
    score:            finalScore,
    raw_score:        Math.round(rawScore),
    classification:   scoreRow.classification,
    label:            scoreRow.label,
    color:            scoreRow.color,
    water_status:     scoreRow.water_status,   // DB enum: 'safe'|'warning'|'danger'

    // ── Score-range guidance (from PDF Score Range Table) ──────────────────
    score_range:      scoreRow.range,
    recommended_use:  scoreRow.recommended_use,
    not_recommended:  scoreRow.not_recommended,
    explanation:      scoreRow.explanation,

    // ── Condition-specific guidance (from PDF Combined Results Table) ───────
    condition:         conditionRow.condition,
    condition_allowed: conditionRow.allowed_use,
    condition_not_rec: conditionRow.not_recommended,
    condition_reason:  conditionRow.reason,

    // ── Override details (every triggered rule with its reason) ────────────
    triggered_overrides,
    multi_param_triggered: multiParamTriggered,

    // ── Per-parameter breakdown (score + level + remark from PDF table) ────
    per_param: perParamClean,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  classifyWaterQuality,

  // Individual classifiers (useful for unit testing or single-param checks)
  classifyPH,
  classifyTurbidity,
  classifyTDS,
  classifyAmmonia,
  classifyTemperature,

  // Reference tables (useful for rendering full classification tables in UI)
  PH_TABLE,
  TURBIDITY_TABLE,
  TDS_TABLE,
  AMMONIA_TABLE,
  TEMPERATURE_TABLE,
  OVERRIDE_RULES,
  COMBINED_RESULTS_TABLE,
  SCORE_RANGE_TABLE,
  MULTI_PARAM_RULE,
  SENSOR_FAILURE_RULE,
  CONFLICT_RULE,
};
