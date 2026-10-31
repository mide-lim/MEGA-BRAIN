"""Opt-in, bounded, content-free monotonic preparation observations.

Context-local: no files, callbacks, logging, credentials or network operations.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from time import monotonic_ns
from threading import Lock

PHASES = frozenset(('history', 'prior', 'media', 'media_read', 'media_hash',
                    'ffprobe', 'request', 'final_controls', 'preparation', 'coordination',
                    'shared_preparation'))
COUNTERS = frozenset(('directories', 'entries', 'history_reads', 'history_bytes',
                      'artifact_reads', 'artifact_bytes', 'artifact_verifications',
                      'media_reads', 'media_bytes', 'prior_rows'))
LIMIT = (1 << 63) - 1
_ACTIVE = ContextVar('preparation_metrics', default=None)


class Metrics:
    def __init__(self, *, clock=monotonic_ns):
        self.clock = clock
        self.spans = {}
        self.counters = {}
        self._lock = Lock()

    @staticmethod
    def _bounded(value):
        if type(value) is not int or not 0 <= value <= LIMIT:
            raise ValueError('metric bound')
        return value

    def count(self, label, amount=1):
        if label not in COUNTERS:
            raise ValueError('metric label')
        with self._lock:
            self.counters[label] = self._bounded(self.counters.get(label, 0) + self._bounded(amount))

    @contextmanager
    def span(self, label):
        if label not in PHASES:
            raise ValueError('metric label')
        start = self._bounded(self.clock())
        failed = False
        try:
            yield
        except BaseException:
            failed = True
            raise
        finally:
            elapsed = self._bounded(self._bounded(self.clock()) - start)
            with self._lock:
                old = self.spans.get(label, {'count': 0, 'duration_ns': 0, 'exceptions': 0})
                self.spans[label] = {key: self._bounded(old[key] + value) for key, value in
                                     (('count', 1), ('duration_ns', elapsed), ('exceptions', int(failed)))}

    @contextmanager
    def activate(self):
        token = _ACTIVE.set(self)
        try:
            yield self
        finally:
            _ACTIVE.reset(token)

    def snapshot(self):
        with self._lock:
            return {'spans': {k: dict(v) for k, v in sorted(self.spans.items())},
                    'counters': dict(sorted(self.counters.items()))}


# Operational scopes use a failure-isolating facade; explicit Metrics stays strict.
_OPERATION = ContextVar('executor_operation', default=None)


class _SafeMetrics:
    def __init__(self, owner):
        self.owner = owner
        self.raw = None
        self.mirror = None
        try:
            self.raw = Metrics(clock=monotonic_ns)
        except BaseException:
            owner.available = False
        try:
            self.mirror = _ACTIVE.get()
        except BaseException:
            owner.available = False

    def count(self, label, amount=1):
        for collector in (self.raw, self.mirror):
            if collector is not None:
                try:
                    collector.count(label, amount)
                except BaseException:
                    self.owner.available = False

    @contextmanager
    def span(self, label):
        managers = []
        for collector in (self.raw, self.mirror):
            if collector is not None:
                try:
                    manager = collector.span(label)
                    manager.__enter__()
                    managers.append(manager)
                except BaseException:
                    self.owner.available = False
        try:
            yield
        except BaseException:
            import sys
            info = sys.exc_info()
            for manager in reversed(managers):
                try:
                    manager.__exit__(*info)
                except BaseException:
                    self.owner.available = False
            raise
        else:
            for manager in reversed(managers):
                try:
                    manager.__exit__(None, None, None)
                except BaseException:
                    self.owner.available = False

    def snapshot(self):
        try:
            # Copy only fixed labels and bounded values, even if a collector is replaced.
            value = self.raw.snapshot()
            return {'counters': {k: _number(v) for k, v in value['counters'].items() if k in COUNTERS},
                    'spans': {k: {field: _number(v[field]) for field in
                               ('count', 'duration_ns', 'exceptions')}
                              for k, v in value['spans'].items() if k in PHASES}}
        except BaseException:
            self.owner.available = False
            return {'counters': {}, 'spans': {}}


def _number(value):
    if type(value) is not int or not 0 <= value <= LIMIT:
        raise ValueError('metric bound')
    return value


class _Operation:
    def __init__(self, entry, kind):
        self.entry = entry
        self.kind = kind
        self.available = True
        self.synthetic = False
        self.boundary = False
        self.frozen = None
        self.status = 'returned'
        self.result_state = 'unavailable'
        self.start = self.tick()
        self.metrics = _SafeMetrics(self)

    def tick(self):
        try:
            return _number(monotonic_ns())
        except BaseException:
            self.available = False
            return None

    def elapsed(self):
        end = self.tick()
        try:
            return _number(end - self.start) / 1000000
        except BaseException:
            self.available = False
            return None

    def freeze(self):
        if not self.boundary:
            self.frozen = self.elapsed()
            self.boundary = True

    def report(self):
        partial = self.elapsed()
        components = self.metrics.snapshot()
        coverage = ('unavailable' if not self.available else
                    'interrupted' if self.status == 'interrupted' else
                    'rejected' if not self.boundary and self.status == 'raised' else
                    'recovery' if self.kind == 'recovery' else
                    'control' if self.kind == 'control' else
                    'NEW_COMPLETE' if self.boundary else 'partial')
        return {'entry_point': self.entry, 'kind': self.kind, 'status': self.status,
                'synthetic': self.synthetic, 'boundary_reached': self.boundary,
                'coverage': coverage,
                'result_state': self.result_state,
                'executor_prepare_ms': self.frozen if self.available else None,
                'partial_elapsed_ms': partial if self.available else None,
                'api_setup_coverage': 'outside_scope' if not self.entry.endswith('.main') else 'included',
                **components}


def _emit(report):
    import json
    import sys
    print(json.dumps({'preparation_observation': report}, sort_keys=True,
                     separators=(',', ':'), allow_nan=False), file=sys.stderr)


def note(*, kind=None, rejected=False):
    """Constant-only operational annotation; never inspects payloads or errors."""
    try:
        operation = _OPERATION.get()
        if operation is not None:
            if kind in ('new', 'recovery', 'control'):
                operation.kind = kind
            if rejected:
                operation.status = 'raised'
    except BaseException:
        pass


def freeze_before_send():
    try:
        operation = _OPERATION.get()
        if operation is not None:
            operation.freeze()
    except BaseException:
        pass


def _context_read(context):
    try:
        return context.get(), True
    except BaseException:
        return None, False


def _context_install(context, value, operation):
    try:
        return context.set(value)
    except BaseException:
        operation.available = False
        return None


def _context_restore(context, token, previous, known, operation):
    try:
        if token is not None:
            context.reset(token)
            return
    except BaseException:
        operation.available = False
    # A wrapper may raise before OR after changing the real context. Never
    # depend on reset's failure implying that no mutation occurred.
    try:
        if not known and token is not None:
            from contextvars import Token
            previous = token.old_value
            if previous is Token.MISSING:
                previous = None
            known = True
        if known:
            context.set(previous)
    except BaseException:
        operation.available = False


def _annotate(operation, args, kind):
    try:
        if kind == 'recovery' and operation.kind != 'control':
            operation.kind = kind
        if args and getattr(args[0], 'synthetic', False) is True:
            operation.synthetic = True
    except BaseException:
        operation.available = False


def operational(entry, kind='new'):
    if entry not in ('worker.main', 'recurrence.main', 'Pipeline.run', 'Pipeline.recover',
                     'Queue.run_one', 'Queue.recover') or kind not in ('new', 'recovery', 'control'):
        raise ValueError('operation label')
    def decorate(function):
        @wraps(function)
        def call(*args, **kwargs):
            parent, parent_known = _context_read(_OPERATION)
            if parent is not None:
                _annotate(parent, args, kind)
                result = function(*args, **kwargs)
                _result(parent, result)
                return result
            # Keep all observational initialization separate from the body.
            previous, active_known = _context_read(_ACTIVE)
            operation = None
            active_token = operation_token = None
            try:
                operation = _Operation(entry, kind)
                operation.available = operation.available and parent_known and active_known
                _annotate(operation, args, kind)
                operation_token = _context_install(_OPERATION, operation, operation)
                active_token = _context_install(_ACTIVE, operation.metrics, operation)
            except BaseException:
                pass
            try:
                result = function(*args, **kwargs)
                _result(operation, result)
                return result
            except BaseException as exc:
                if operation is not None:
                    operation.status = 'raised' if isinstance(exc, Exception) else 'interrupted'
                raise
            finally:
                # Each cleanup is independently guarded, even if the other fails.
                if operation is not None:
                    _context_restore(_ACTIVE, active_token, previous, active_known, operation)
                    _context_restore(_OPERATION, operation_token, parent, parent_known, operation)
                try:
                    if operation is not None:
                        _emit(operation.report())
                except BaseException:
                    pass
        return call
    return decorate


def _result(operation, result):
    try:
        if operation is not None and type(result) is dict:
            state = result.get('state')
            if state in ('UNKNOWN', 'RESERVED', 'PERSISTED', 'BLOCKED', 'PERSISTENCE_UNCERTAIN'):
                operation.result_state = state
    except BaseException:
        pass


def current():
    operation, _ = _context_read(_OPERATION)
    if operation is not None:
        return operation.metrics
    metrics, _ = _context_read(_ACTIVE)
    return metrics


def count(label, amount=1):
    metrics = current()
    if metrics is not None:
        metrics.count(label, amount)


@contextmanager
def span(label):
    metrics = current()
    if metrics is None:
        yield
    else:
        with metrics.span(label):
            yield


def measured(label):
    def decorate(function):
        @wraps(function)
        def call(*args, **kwargs):
            with span(label):
                return function(*args, **kwargs)
        return call
    return decorate
