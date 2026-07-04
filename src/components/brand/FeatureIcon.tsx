export type FeatureIconId =
  | "ic-qr"
  | "ic-pos"
  | "ic-chat"
  | "ic-table"
  | "ic-inventory"
  | "ic-analytics";

export function FeatureIconSprite() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <symbol id="ic-qr" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={3} y={3} width={7} height={7} rx={1.6} />
            <rect x={14} y={3} width={7} height={7} rx={1.6} />
            <rect x={3} y={14} width={7} height={7} rx={1.6} />
          </g>
          <g fill="currentColor">
            <rect x={15} y={15} width={2.6} height={2.6} rx={0.7} />
            <rect x={18.4} y={18.4} width={2.6} height={2.6} rx={0.7} />
            <rect x={15} y={19} width={2.6} height={2} rx={0.7} />
            <rect x={19} y={15} width={2} height={2.6} rx={0.7} />
          </g>
        </symbol>

        <symbol id="ic-pos" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={5} y={2.5} width={14} height={19} rx={2.6} />
            <rect x={8} y={5.5} width={8} height={4.5} rx={1} />
          </g>
          <g fill="currentColor">
            <circle cx={9.4} cy={14.2} r={1.15} />
            <circle cx={14.6} cy={14.2} r={1.15} />
            <circle cx={9.4} cy={18} r={1.15} />
            <circle cx={14.6} cy={18} r={1.15} />
          </g>
        </symbol>

        <symbol id="ic-chat" viewBox="0 0 24 24">
          <path
            d="M7 4 h10 a4 4 0 0 1 4 4 v4 a4 4 0 0 1 -4 4 h-6 l-4.5 3.4 v-3.4 a4 4 0 0 1 -3.5 -4 v-4 a4 4 0 0 1 4 -4 z"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <g fill="currentColor">
            <circle cx={8.6} cy={10} r={1.15} />
            <circle cx={12} cy={10} r={1.15} />
            <circle cx={15.4} cy={10} r={1.15} />
          </g>
        </symbol>

        <symbol id="ic-table" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx={12} cy={12} r={5.5} />
            <rect x={9} y={1.6} width={6} height={2.6} rx={1.3} />
            <rect x={9} y={19.8} width={6} height={2.6} rx={1.3} />
            <rect x={1.6} y={9} width={2.6} height={6} rx={1.3} />
            <rect x={19.8} y={9} width={2.6} height={6} rx={1.3} />
          </g>
        </symbol>

        <symbol id="ic-inventory" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={4} y={6} width={16} height={14} rx={2.2} />
            <path d="M4 11 H20" />
            <path d="M12 6 V11" />
            <path d="M9.5 15 H14.5" />
          </g>
        </symbol>

        <symbol id="ic-analytics" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 3.5 V20 H20.5" />
            <path d="M7.5 15 L11 11 L14 13.5 L19.5 7" />
          </g>
          <circle cx={19.5} cy={7} r={1.7} fill="currentColor" />
        </symbol>
      </defs>
    </svg>
  );
}

export function FeatureIcon({ id, className }: { id: FeatureIconId; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}
