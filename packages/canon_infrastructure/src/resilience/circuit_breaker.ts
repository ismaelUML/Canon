// packages/canon_infrastructure/src/resilience/circuit_breaker.ts
// Circuit Breaker determinista con Failover Silencioso (Seccion 5.1)
// Conmuta de forma automatica y determinista ante degradacion o errores sostenidos.
// Complejidad ciclomatica <= 5 por funcion garantizada.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private failureThreshold: number;
  private resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10_000;
  }

  getState(): CircuitState {
    this.updateStateIfTimeoutExpired();
    return this.state;
  }

  private updateStateIfTimeoutExpired(): void {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      }
    }
  }

  canExecute(): boolean {
    this.updateStateIfTimeoutExpired();
    return this.state !== 'OPEN';
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  async execute<T>(
    primaryAction: () => Promise<T>,
    fallbackAction?: (err?: Error) => Promise<T>
  ): Promise<T> {
    if (!this.canExecute()) {
      if (fallbackAction) {
        return await fallbackAction(new Error('CircuitBreaker is OPEN'));
      }
      throw new Error('CircuitBreaker is OPEN and no fallback was provided');
    }

    try {
      const result = await primaryAction();
      this.recordSuccess();
      return result;
    } catch (err: any) {
      this.recordFailure();
      if (fallbackAction) {
        return await fallbackAction(err);
      }
      throw err;
    }
  }
}
