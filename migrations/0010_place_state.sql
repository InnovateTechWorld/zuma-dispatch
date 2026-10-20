-- 0010: Zuma serves two states (FCT and Lagos State), so each resolved place records which one it is
-- in ('FC', 'LA', or NULL when outside both). Computed from the coordinates by src/business/states.ts
-- on insert. Older places that were in the service area were all inside the original 40 km Abuja
-- radius, so they are FCT.
ALTER TABLE places ADD COLUMN state TEXT CHECK (state IS NULL OR state IN ('FC', 'LA'));
UPDATE places SET state = 'FC' WHERE in_service_area = 1;
