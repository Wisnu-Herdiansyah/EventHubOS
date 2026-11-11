/**
 * A small, original line-icon set (20×20, 1.6px strokes, currentColor). Icons are decorative:
 * the control that holds one always has a text label, visible or visually hidden.
 */
const PATHS = {
  home: 'M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3.5v-5h-4v5H4.5a1 1 0 0 1-1-1z',
  building:
    'M4 17V4.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V17M12 8h3a1 1 0 0 1 1 1v8M2.5 17h15M7 7h2M7 10h2M7 13h2',
  overview: 'M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z',
  users:
    'M7.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2.5 16.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5M13 3.7a3 3 0 0 1 0 5.6M14.5 12.2c1.8.5 3 1.9 3 4.3',
  gear: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  history: 'M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3M10 6.5V10l2.5 1.5',
  person: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 16.5c0-3 2.7-5 6-5s6 2 6 5',
  calendar:
    'M4.5 4.5h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1M3.5 8.5h13M7 2.5v3M13 2.5v3',
  sidebar: 'M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M8 4.5v11',
  menu: 'M3 5.5h14M3 10h14M3 14.5h14',
  close: 'M5 5l10 10M15 5 5 15',
  check: 'M4.5 10.5 8 14l7.5-8',
  chart: 'M3.5 16.5h13M6 13.5v-4M10 13.5v-8M14 13.5v-6',
  camera:
    'M3.5 6.5h3l1.5-2h4l1.5 2h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M10 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  download: 'M10 3.5v9.5M6 9.5l4 4 4-4M4 16.5h12',
  mail: 'M4 5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M3.5 6l6.5 5 6.5-5',
  lock: 'M5.5 9h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1M7 9V6.5a3 3 0 0 1 6 0V9',
  plus: 'M10 4v12M4 10h12',
  search: 'M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M13 13l4 4',
  chevronDown: 'M5.5 8 10 12.5 14.5 8',
  chevronRight: 'M8 5.5 12.5 10 8 14.5',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M10 9v4.5M10 6.5v.01',
  warning: 'M10 3.5 17.5 16.5h-15zM10 8.5v3.5M10 14.5v.01',
  error: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M7.5 7.5l5 5M12.5 7.5l-5 5',
  success: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M6.8 10.2l2.2 2.2 4.2-4.6',
  signOut: 'M8 16.5H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H8M12.5 13.5 16 10l-3.5-3.5M16 10H7.5',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M10 1.5v1.5M10 17v1.5M1.5 10H3M17 10h1.5M4 4l1 1M15 15l1 1M4 16l1-1M15 5l1-1',
  moon: 'M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9',
  monitor:
    'M3.5 4h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M7 17h6M10 14v3',
  eye: 'M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  eyeOff:
    'M3 3l14 14M8.2 5a8.6 8.6 0 0 1 1.8-.2c5.5 0 8.5 5.2 8.5 5.2a14 14 0 0 1-2.2 2.8M5.3 6.3A13.6 13.6 0 0 0 1.5 10s3 5.5 8.5 5.5a8 8 0 0 0 3.6-.8M8.3 8.3a2.5 2.5 0 0 0 3.4 3.4',
  copy: 'M7.5 7.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M4.5 12.5h-1a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1',
  arrowUp: 'M10 16V4M5 9l5-5 5 5',
  arrowDown: 'M10 4v12M5 11l5 5 5-5',
  undo: 'M7 4.5 3.5 8 7 11.5M3.5 8H12a4.5 4.5 0 0 1 0 9H8',
  redo: 'M13 4.5 16.5 8 13 11.5M16.5 8H8a4.5 4.5 0 0 0 0 9h4',
  phone: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1M9 15h2',
  tablet: 'M4.5 2.5h11a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1M9 15h2',
  desktop: 'M2.5 4h15v9.5h-15zM7 17h6M10 13.5V17',
  layers: 'M10 3 17.5 7 10 11 2.5 7zM2.5 10.5 10 14.5l7.5-4M2.5 14 10 18l7.5-4',
  more: 'M5 10v.01M10 10v.01M15 10v.01',
  external:
    'M11.5 3.5h5v5M16.5 3.5 9 11M14.5 11.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4',
  trash:
    'M3.5 5.5h13M8 5.5V3.5h4v2M5 5.5l.8 11a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9l.8-11M8.5 9v5M11.5 9v5',
  drag: 'M7.5 5v.01M12.5 5v.01M7.5 10v.01M12.5 10v.01M7.5 15v.01M12.5 15v.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
