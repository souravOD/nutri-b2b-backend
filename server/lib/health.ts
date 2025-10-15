import type { CustomerHealthProfile } from "../../shared/schema.js";

export interface HealthMetrics {
  bmi: number;
  bmr: number;
  tdee: number;
  derivedLimits: Record<string, any>;
}

// Exact Mifflin-St Jeor BMR calculation as specified in PRD
export function calculateBMR(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: 'male' | 'female' | 'other' | 'unspecified'
): number {
  if (gender === 'male') {
    return 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  } else {
    // Use female formula for all non-male genders
    return 10 * weightKg + 6.25 * heightCm - 5 * age - 161;
  }
}

// TDEE calculation with exact activity factors from PRD
export function calculateTDEE(bmr: number, activityLevel: string): number {
  const factors = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    very: 1.725,
    extra: 1.9
  };

  const factor = factors[activityLevel as keyof typeof factors] || 1.2;
  return bmr * factor;
}

// BMI calculation
export function calculateBMI(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

// Derive daily nutrient limits based on health conditions
export function deriveDailyLimits(
  profile: Partial<CustomerHealthProfile>,
  conditionRules: any[] = []
): Record<string, any> {
  const baseLimits = {
    calories: profile.tdeeCached || 2000,
    sodium: 2300, // mg
    sugar: 50, // g
    saturatedFat: 20, // g
    cholesterol: 300, // mg
    fiber: 25 // g (target, not limit)
  };

  // Apply condition-specific modifications
  const derivedLimits = { ...baseLimits };

  for (const condition of profile.conditions || []) {
    const rule = conditionRules.find(r => r.conditionCode === condition);
    if (rule && rule.policy.dailyLimits) {
      Object.assign(derivedLimits, rule.policy.dailyLimits);
    }
  }

  return derivedLimits;
}

// Calculate comprehensive health metrics
export function calculateHealthMetrics(
  profile: Partial<CustomerHealthProfile>,
  conditionRules: any[] = []
): HealthMetrics {
  const bmi = calculateBMI(
    Number(profile.weightKg),
    Number(profile.heightCm)
  );

  const bmr = calculateBMR(
    Number(profile.weightKg),
    Number(profile.heightCm),
    Number(profile.age),
    profile.gender || 'unspecified'
  );

  const tdee = calculateTDEE(bmr, profile.activityLevel || 'sedentary');

  const derivedLimits = deriveDailyLimits(
    { ...profile, tdeeCached: tdee },
    conditionRules
  );

  return {
    bmi: Math.round(bmi * 100) / 100,
    bmr: Math.round(bmr * 100) / 100,
    tdee: Math.round(tdee * 100) / 100,
    derivedLimits
  };
}

// Health-aware product scoring for matching
export function scoreProductForHealth(
  product: any,
  customerProfile: CustomerHealthProfile
): number {
  let score = 100; // Base score

  // Check allergen restrictions (hard filter in practice)
  const productAllergens = product.allergens || [];
  const avoidAllergens = customerProfile.avoidAllergens || [];
  
  for (const allergen of productAllergens) {
    if (avoidAllergens.includes(allergen)) {
      return 0; // Hard exclusion
    }
  }

  // Apply soft budget scoring based on derived limits
  const nutrition = product.nutrition || {};
  const limits = customerProfile.derivedLimits || {};

  // Penalize products that consume large fractions of daily budgets
  if (limits.sodium && nutrition.sodium) {
    const sodiumFraction = nutrition.sodium / limits.sodium;
    if (sodiumFraction > 0.3) {
      score -= 20 * sodiumFraction;
    }
  }

  if (limits.sugar && nutrition.sugar) {
    const sugarFraction = nutrition.sugar / limits.sugar;
    if (sugarFraction > 0.25) {
      score -= 25 * sugarFraction;
    }
  }

  // Bonus for fiber (beneficial for many conditions)
  if (nutrition.fiber && customerProfile.conditions?.includes('diabetes')) {
    score += Math.min(15, nutrition.fiber * 2);
  }

  // Ensure score doesn't go below 0
  return Math.max(0, Math.round(score));
}

// Default condition rules (would be stored in database)
export const DEFAULT_CONDITION_RULES = [
  {
    conditionCode: 'diabetes',
    policy: {
      dailyLimits: {
        sugar: 25, // Reduced sugar limit
        fiber: 35 // Increased fiber target
      }
    }
  },
  {
    conditionCode: 'hypertension',
    policy: {
      dailyLimits: {
        sodium: 1500 // Reduced sodium limit
      }
    }
  },
  {
    conditionCode: 'heart_disease',
    policy: {
      dailyLimits: {
        saturatedFat: 13, // Reduced saturated fat
        cholesterol: 200 // Reduced cholesterol
      }
    }
  }
];
