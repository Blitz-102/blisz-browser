import styles from './icons.module.css';

// Paths copied from Lucide (ISC, see ./LICENSE). Size comes from --icon-size, colour from currentColor.
const svgProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: styles.icon,
} as const;

export function ArrowLeftIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

export function ArrowRightIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function RotateCwIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function ChevronUpIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...svgProps} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
