// packages/canon_presentation/src/concurrency/bounded_queue.ts
// Cola de tareas acotada con contrapresion (Backpressure) estricta (Seccion 5.2).
// MaxConcurrentWorkers + MaxQueueSize con saturacion inmediata (HTTP 429/503).
// Complejidad ciclomatica <= 5 por funcion garantizada.

export class CapacitySaturatedError extends Error {
  public readonly code: number = 429;
  constructor(message: string = 'Capacidad del servidor saturada. Cola de procesamiento llena (Backpressure).') {
    super(message);
    this.name = 'CapacitySaturatedError';
  }
}

interface QueuedTask<T> {
  action: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
  signal?: AbortSignal;
}

export class BoundedTaskQueue {
  private maxWorkers: number;
  private maxQueueSize: number;
  private activeWorkers: number = 0;
  private queue: QueuedTask<any>[] = [];

  constructor(maxWorkers: number = 4, maxQueueSize: number = 50) {
    this.maxWorkers = maxWorkers;
    this.maxQueueSize = maxQueueSize;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveWorkers(): number {
    return this.activeWorkers;
  }

  enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Operación cancelada por AbortSignal antes de encolar.'));
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new CapacitySaturatedError(
        `Capacidad concurrente excedida (límite: ${this.maxQueueSize} encolados). Rechazo inmediato.`
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ action, resolve, reject, signal });
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeWorkers < this.maxWorkers && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      if (task.signal?.aborted) {
        task.reject(new Error('Operación cancelada por AbortSignal en cola.'));
        continue;
      }

      void this.executeWorker(task);
    }
  }

  private async executeWorker<T>(task: QueuedTask<T>): Promise<void> {
    this.activeWorkers++;
    try {
      const result = await task.action();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.activeWorkers--;
      this.pump();
    }
  }
}
