/** All internal geometry is stored in inches; PDF drawing uses points. */
export const PT_PER_IN = 72;

export const inToPt = (inches: number): number => inches * PT_PER_IN;
export const ptToIn = (pt: number): number => pt / PT_PER_IN;
export const mmToIn = (mm: number): number => mm / 25.4;
export const inToMm = (inches: number): number => inches * 25.4;

/** Round to a fixed number of decimals so geometry is stable across platforms. */
export const round = (value: number, decimals = 4): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** Floating point comparison tolerance for geometry checks (1/1000 inch). */
export const GEOMETRY_TOLERANCE_IN = 0.001;

export const approxEqual = (a: number, b: number, tol = GEOMETRY_TOLERANCE_IN): boolean =>
  Math.abs(a - b) <= tol;
