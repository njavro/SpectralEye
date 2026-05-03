// Visual constants for threats and defended objects (Phase 6).

export const DRONE_COLOR = {
  clear: '#4ade80', // green — link healthy, no intrusion
  jammed: '#fb923c', // orange — comms degraded
  intrusion: '#dc2626', // red — inside an OoI safety perimeter (ALARM)
}

export const OOI_COLOR = {
  marker: '#22c55e', // green diamond
  perimeterFill: 'rgba(34, 197, 94, 0.10)',
  perimeterEdge: 'rgba(34, 197, 94, 0.85)',
  perimeterFillAlarm: 'rgba(220, 38, 38, 0.18)',
  perimeterEdgeAlarm: 'rgba(220, 38, 38, 1.0)',
}

export const TRAJECTORY_COLOR = {
  planned: 'rgba(140, 196, 255, 0.85)',
  traveled: 'rgba(255, 255, 255, 0.45)',
}
