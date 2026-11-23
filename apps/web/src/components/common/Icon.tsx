type IconName =
  | 'layers'
  | 'users'
  | 'lock'
  | 'mail'
  | 'eye'
  | 'eye-off'
  | 'shield'
  | 'arrow-right'
  | 'chevron-right'
  | 'search'
  | 'refresh'
  | 'logout'
  | 'calendar'
  | 'check'
  | 'menu'
  | 'close'
  | 'chat'
  | 'settings'
  | 'plus'
  | 'trash'
  | 'image'
  | 'debug';

const paths: Record<IconName, string[]> = {
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  lock: ['M5 10h14v11H5z', 'M8 10V7a4 4 0 0 1 8 0v3', 'M12 14v3'],
  mail: ['M3 5h18v14H3z', 'm3 5 9 7 9-7'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  'eye-off': [
    'm3 3 18 18',
    'M10.6 5.1A12 12 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3 4',
    'M6 6a19 19 0 0 0-4 6s3 7 10 7a12 12 0 0 0 5-1',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z', 'm8 12 3 3 5-5'],
  'arrow-right': ['M4 12h16', 'm14 6 6 6-6 6'],
  'chevron-right': ['m9 5 7 7-7 7'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z', 'm16 16 5 5'],
  refresh: ['M20 7a9 9 0 0 0-15-2L2 8', 'M2 3v5h5', 'M4 17a9 9 0 0 0 15 2l3-3', 'M22 21v-5h-5'],
  logout: ['M9 21H3V3h6', 'M9 12h12', 'm17 8 4 4-4 4'],
  calendar: ['M3 5h18v16H3z', 'M3 10h18', 'M7 3v4', 'M17 3v4', 'M7 14h2', 'M15 14h2'],
  check: ['m5 12 4 4L19 6'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  close: ['m6 6 12 12', 'm18 6-12 12'],
  chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5a10 10 0 0 1 20 0Z', 'M7 10h10', 'M7 14h6'],
  settings: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'm9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M3 6h18', 'M9 6V3h6v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
  image: ['M3 3h18v18H3z', 'm3 17 6-6 4 4 3-3 5 5', 'M15 8h.01'],
  debug: [
    'M8 9h8v9a4 4 0 0 1-8 0V9Z',
    'M9 9V7a3 3 0 0 1 6 0v2',
    'M12 9v13',
    'M4 10h4',
    'M16 10h4',
    'M4 15h4',
    'M16 15h4',
    'm5 21 3-3',
    'm16 18 3 3',
  ],
};

export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
