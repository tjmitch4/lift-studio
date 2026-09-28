// Lift Studio — TJ's seeded program (PPL split, 2026-08-29)
// weight semantics per exercise: loadLabel tells you what "weight" means.
//   'bar'     — total bar weight incl. 45lb bar (plate math shown per side)
//   'sleeve'  — plates loaded on one landmine sleeve
//   'per DB'  — weight of each dumbbell
//   'total'   — total stack/load on the cable
//   'per side'— plates per side of the cable
//   'body'    — bodyweight / timed
// type: barbell | landmine | dumbbell | cable | timed

const SEED_PROGRAM = {
  days: [
    { id: 'push', name: 'Push' },
    { id: 'pull', name: 'Pull' },
    { id: 'legs', name: 'Legs' },
  ],
  exercises: [
    // ---- PUSH ----
    { id: 'bench',      day: 'push', name: 'Barbell Bench Press',        type: 'barbell',  loadLabel: 'bar',      sets: 4, repLow: 6,  repHigh: 8,  weight: 135, increment: 5 },
    { id: 'incline-db', day: 'push', name: 'DB Incline Bench Press',     type: 'dumbbell', loadLabel: 'per DB',   sets: 3, repLow: 8,  repHigh: 10, weight: 45,  increment: 5 },
    { id: 'landmine',   day: 'push', name: 'Landmine Press',             type: 'landmine', loadLabel: 'sleeve',   sets: 3, repLow: 8,  repHigh: 10, weight: 45,  increment: 5 },
    { id: 'lateral',    day: 'push', name: 'DB Lateral Raise',           type: 'dumbbell', loadLabel: 'per DB',   sets: 3, repLow: 8,  repHigh: 10, weight: 15,  increment: 2.5,
      coachNote: 'Drop to 10–12 lb if form breaks down' },
    { id: 'pushdown',   day: 'push', name: 'Cable Tricep Pushdown',      type: 'cable',    loadLabel: 'total',    sets: 3, repLow: 8,  repHigh: 10, weight: 40,  increment: 5 },
    // ---- PULL ----
    { id: 'pulldown',   day: 'pull', name: 'Cable Lat Pulldown',         type: 'cable',    loadLabel: 'total',    sets: 3, repLow: 8,  repHigh: 10, weight: 90,  increment: 5 },
    { id: 'lying-row',  day: 'pull', name: 'DB Lying Row',               type: 'dumbbell', loadLabel: 'per DB',   sets: 3, repLow: 8,  repHigh: 10, weight: 45,  increment: 5 },
    { id: 'facepull',   day: 'pull', name: 'Face Pulls',                 type: 'cable',    loadLabel: 'per side', sets: 4, repLow: 12, repHigh: 15, weight: 20,  increment: 2.5,
      coachNote: 'Consider 12.5–15 lb/side for strict form' },
    { id: 'curl',       day: 'pull', name: 'DB Curl',                    type: 'dumbbell', loadLabel: 'per DB',   sets: 3, repLow: 8,  repHigh: 10, weight: 25,  increment: 2.5 },
    { id: 'preacher',   day: 'pull', name: 'DB Preacher Curl',           type: 'dumbbell', loadLabel: 'per DB',   sets: 2, repLow: 8,  repHigh: 10, weight: null, increment: 2.5,
      coachNote: 'First session: find a weight that leaves 2 reps in the tank' },
    // ---- LEGS ----
    { id: 'squat',      day: 'legs', name: 'Barbell Squat',              type: 'barbell',  loadLabel: 'bar',      sets: 3, repLow: 8,  repHigh: 10, weight: 135, increment: 5 },
    { id: 'rdl',        day: 'legs', name: 'Romanian Deadlift',          type: 'barbell',  loadLabel: 'bar',      sets: 3, repLow: 8,  repHigh: 10, weight: null, increment: 5,
      coachNote: 'New pattern — start light (bar +25s), groove the hinge first' },
    { id: 'leg-curl',   day: 'legs', name: 'Leg Curl',                   type: 'cable',    loadLabel: 'total',    sets: 3, repLow: 10, repHigh: 12, weight: null, increment: 5 },
    { id: 'calf',       day: 'legs', name: 'Barbell Standing Calf Raise',type: 'barbell',  loadLabel: 'bar',      sets: 3, repLow: 8,  repHigh: 10, weight: null, increment: 5 },
    { id: 'lunge',      day: 'legs', name: 'DB Walking Lunge',           type: 'dumbbell', loadLabel: 'per DB',   sets: 2, repLow: 8,  repHigh: 10, weight: null, increment: 2.5 },
    { id: 'plank',      day: 'legs', name: 'Front Plank',                type: 'timed',    loadLabel: 'body',     sets: 3, repLow: 60, repHigh: 60, weight: 0,   increment: 0 },
  ],
  settings: {
    barWeight: 45,
    // pairs available at home (standard 300lb set)
    platePairs: [45, 25, 10, 5, 2.5],
    restDefault: 90,          // seconds, isolation work
    restCompound: 150,        // seconds, barbell compounds
    progressAfter: 2,         // consecutive top-of-range sessions -> add weight
    deloadAfter: 3,           // consecutive missed sessions -> deload
    deloadPct: 0.10,
  },
  cardioKinds: ['Hoops', 'Tennis', 'Row', 'Run', 'Walk', 'Other'],
};
