'use strict';
// Sequential GPU job queue (upscaling and animation share the RTX — one at a time).
const { EventEmitter } = require('events');
const log = require('./log');

let seq = 0;

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.running = null;
  }

  add(kind, title, runner, meta = {}) {
    const job = {
      id: `job-${Date.now().toString(36)}-${(++seq).toString(36)}`,
      kind, title, meta,
      status: 'queued', progress: 0, stage: 'Na fila', result: null, error: '',
      createdAt: Date.now(), startedAt: 0, endedAt: 0,
    };
    job._runner = runner;
    job._cancel = null;
    this.jobs.unshift(job);
    if (this.jobs.length > 200) this.jobs = this.jobs.filter((j, i) => i < 200 || j.status === 'running' || j.status === 'queued');
    this.emitJob(job);
    this.pump();
    return job.id;
  }

  public(job) {
    const { _runner, _cancel, ...rest } = job;
    return rest;
  }

  list() { return this.jobs.map((j) => this.public(j)); }

  emitJob(job) { this.emit('job', this.public(job)); }

  update(job, patch) {
    Object.assign(job, patch);
    this.emitJob(job);
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status === 'queued') { this.update(job, { status: 'canceled', stage: 'Cancelado', endedAt: Date.now() }); return true; }
    if (job.status === 'running') {
      job.canceled = true;
      if (job._cancel) { try { job._cancel(); } catch (_) { /* ignore */ } }
      this.update(job, { stage: 'Cancelando…' });
      return true;
    }
    return false;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    this.emit('cleared');
  }

  async pump() {
    if (this.running) return;
    const job = this.jobs.slice().reverse().find((j) => j.status === 'queued');
    if (!job) return;
    this.running = job;
    this.update(job, { status: 'running', stage: 'Iniciando…', startedAt: Date.now() });
    const ctx = {
      progress: (p, stage) => this.update(job, {
        ...(typeof p === 'number' && Number.isFinite(p) ? { progress: Math.max(0, Math.min(1, p)) } : {}),
        ...(stage ? { stage } : {}),
      }),
      stage: (stage) => this.update(job, { stage }),
      onCancel: (fn) => { job._cancel = fn; },
      get canceled() { return !!job.canceled; },
      checkCanceled() { if (job.canceled) { const e = new Error('Cancelado'); e.canceled = true; throw e; } },
    };
    try {
      const result = await job._runner(ctx);
      if (job.canceled) this.update(job, { status: 'canceled', stage: 'Cancelado', endedAt: Date.now() });
      else this.update(job, { status: 'done', progress: 1, stage: 'Concluído', result, endedAt: Date.now() });
    } catch (err) {
      if (job.canceled || err.canceled) this.update(job, { status: 'canceled', stage: 'Cancelado', endedAt: Date.now() });
      else {
        log.error(`job ${job.kind} falhou`, err);
        this.update(job, { status: 'error', error: err.message || String(err), stage: 'Erro', endedAt: Date.now() });
      }
    } finally {
      job._cancel = null;
      this.running = null;
      setImmediate(() => this.pump());
    }
  }
}

module.exports = { JobQueue };
