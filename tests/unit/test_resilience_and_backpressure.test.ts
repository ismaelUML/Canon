// tests/unit/test_resilience_and_backpressure.test.ts
// Tests unitarios de Resiliencia, Concurrencia y Contrapresion (Seccion 5):
// 1. Circuit Breaker determinista con Failover Silencioso.
// 2. BoundedTaskQueue con rechazo inmediato por saturacion (Backpressure).
// 3. Cancelacion reactiva a traves de AbortSignal.

import test from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker } from '../../packages/canon_infrastructure/src/resilience/circuit_breaker.ts';
import { BoundedTaskQueue, CapacitySaturatedError } from '../../packages/canon_presentation/src/concurrency/bounded_queue.ts';
import { InMemoryEventStore } from '../../packages/canon_infrastructure/src/storage/in_memory.ts';
import { AssertFactUseCase } from '../../packages/canon_application/src/use_cases/assert_fact.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';

test('Resiliencia: CircuitBreaker abre tras 3 fallos y conmuta a fallback sin propagar error', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 50 });
  assert.strictEqual(breaker.getState(), 'CLOSED');

  let callCount = 0;
  const failingOp = async () => {
    callCount++;
    throw new Error('Downstream failure');
  };

  const fallbackOp = async (err?: Error) => {
    return 'fallback_value';
  };

  // 1er y 2do fallo
  const res1 = await breaker.execute(failingOp, fallbackOp);
  const res2 = await breaker.execute(failingOp, fallbackOp);
  assert.strictEqual(res1, 'fallback_value');
  assert.strictEqual(res2, 'fallback_value');
  assert.strictEqual(breaker.getState(), 'CLOSED');

  // 3er fallo: abre circuito
  const res3 = await breaker.execute(failingOp, fallbackOp);
  assert.strictEqual(res3, 'fallback_value');
  assert.strictEqual(breaker.getState(), 'OPEN');

  // Con circuito abierto, conmuta directo al fallback sin invocar la operacion primaria
  const callsBefore = callCount;
  const res4 = await breaker.execute(failingOp, fallbackOp);
  assert.strictEqual(res4, 'fallback_value');
  assert.strictEqual(callCount, callsBefore, 'No debio llamar a failingOp estando en OPEN');

  // Esperar resetTimeout para pasar a HALF_OPEN
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(breaker.getState(), 'HALF_OPEN');

  // Operacion exitosa recupera el circuito a CLOSED
  const resSuccess = await breaker.execute(async () => 'recovered_primary', fallbackOp);
  assert.strictEqual(resSuccess, 'recovered_primary');
  assert.strictEqual(breaker.getState(), 'CLOSED');
});

test('Contrapresion (Backpressure): BoundedTaskQueue rechaza inmediatamente al saturar MaxQueueSize', async () => {
  // Cola con 1 worker y buffer maximo de 2
  const queue = new BoundedTaskQueue(1, 2);

  let activeBlockers = 0;
  const slowTask = () => new Promise<string>((resolve) => {
    activeBlockers++;
    setTimeout(() => {
      activeBlockers--;
      resolve('done');
    }, 50);
  });

  // Tarea 1: Ocupa el worker
  const p1 = queue.enqueue(slowTask);
  // Tarea 2 y 3: Llenan el buffer (tamano 2)
  const p2 = queue.enqueue(slowTask);
  const p3 = queue.enqueue(slowTask);

  // Tarea 4: Debe ser RECHAZADA DE INMEDIATO con CapacitySaturatedError
  assert.throws(
    () => {
      queue.enqueue(slowTask);
    },
    (err: any) => {
      assert(err instanceof CapacitySaturatedError);
      assert.strictEqual(err.code, 429);
      return true;
    }
  );

  const results = await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(results, ['done', 'done', 'done']);
});

test('Cancelacion reactiva: AbortSignal interrumpe operacion y rechaza de forma determinista', async () => {
  const store = new InMemoryEventStore();
  const useCase = new AssertFactUseCase(store);

  const controller = new AbortController();
  controller.abort(); // Señal abortada antes de ejecutar

  const result = await useCase.execute({
    entity_key: 'db:dialect',
    slot_type: 'SINGLE_VALUED',
    value: 'sqlite',
    authority: Authority.USER_EXPLICIT,
    signal: controller.signal,
  });

  assert.strictEqual(result.ok, false);
  assert(result.error?.includes('AbortSignal'));
  const events = await store.getAllEvents();
  assert.strictEqual(events.length, 0, 'No debio persistir ningun evento tras abortar');
});
