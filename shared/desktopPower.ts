export interface TaskPowerStatus {
  enabled: boolean;
  preventingSleep: boolean;
  /** Busy conversations across the whole server, independent of the visible page. */
  activeRooms: number;
}
