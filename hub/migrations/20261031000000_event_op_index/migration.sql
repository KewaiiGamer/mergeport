-- dupEvent (applyOps) looks an operation up by space, type, entity and op id; without this it scans the whole event log.
CREATE INDEX entity_event_op ON entity_event (space_id, type, entity_id, op_id);
