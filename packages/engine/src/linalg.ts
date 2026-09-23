/*
 * PROMOTED (Sprint 3) from experiments/gate-a-electrical/src/linalg.ts at tag sprint-1-complete.
 * The numerical logic is unchanged; production edits are limited to those listed in
 * packages/engine/PROVENANCE.md. experiments/ keeps the original as frozen Gate A evidence.
 */
/**
 * Dense linear algebra for Sprint 0 MNA experiments.
 *
 * Deliberately simple: Sprint 0 circuits have well under 100 unknowns, so a dense
 * LU factorisation with partial pivoting is both fast enough and easy to audit.
 * Sparse storage is a later optimisation, not a feasibility question.
 */

export class SingularMatrixError extends Error {
  constructor(public readonly pivotRow: number) {
    super(`Matrix is singular or numerically singular at pivot row ${pivotRow}`);
    this.name = 'SingularMatrixError';
  }
}

/** Solve A x = b by LU decomposition with partial pivoting. A and b are not modified. */
export function solveLinearSystem(
  A: readonly (readonly number[])[],
  b: readonly number[],
): number[] {
  const n = b.length;
  if (A.length !== n) throw new Error(`Dimension mismatch: A has ${A.length} rows, b has ${n}`);

  // Working copies.
  const m: number[][] = A.map((row) => {
    if (row.length !== n) throw new Error(`Matrix must be square (${n}x${n})`);
    return [...row];
  });
  const x = [...b];

  for (let col = 0; col < n; col++) {
    // Partial pivoting: pick the largest magnitude pivot in this column.
    let pivotRow = col;
    let pivotMag = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const mag = Math.abs(m[r]![col]!);
      if (mag > pivotMag) {
        pivotMag = mag;
        pivotRow = r;
      }
    }
    if (pivotMag === 0 || !Number.isFinite(pivotMag)) throw new SingularMatrixError(col);

    if (pivotRow !== col) {
      const tmp = m[col]!;
      m[col] = m[pivotRow]!;
      m[pivotRow] = tmp;
      const tv = x[col]!;
      x[col] = x[pivotRow]!;
      x[pivotRow] = tv;
    }

    const pivot = m[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! / pivot;
      if (factor === 0) continue;
      m[r]![col] = 0;
      for (let c = col + 1; c < n; c++) {
        m[r]![c] = m[r]![c]! - factor * m[col]![c]!;
      }
      x[r] = x[r]! - factor * x[col]!;
    }
  }

  // Back substitution.
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = x[r]!;
    for (let c = r + 1; c < n; c++) sum -= m[r]![c]! * out[c]!;
    out[r] = sum / m[r]![r]!;
  }
  return out;
}

/** Create an n x n matrix of zeros. */
export function zeroMatrix(n: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(n).fill(0));
}
