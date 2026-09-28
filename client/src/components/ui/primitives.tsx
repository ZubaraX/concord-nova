import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success" | "link";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

const variants: Record<Variant, string> = {
  primary: "star-fill shadow-[0_6px_20px_-8px_rgb(var(--star)/0.7)] hover:brightness-110 active:brightness-95",
  secondary: "bg-raised text-fg hover:bg-overlay",
  ghost: "text-fg-2 hover:text-fg hover:bg-raised",
  danger: "bg-bad text-white hover:brightness-110",
  success: "bg-ok text-[#04150d] hover:brightness-110",
  link: "text-sky hover:underline px-0 h-auto",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-[10px]",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, block, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex select-none items-center justify-center font-semibold transition-[filter,background-color,color,transform] duration-150 active:translate-y-px disabled:opacity-50",
        variants[variant],
        variant !== "link" && sizes[size],
        block && "w-full",
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="anim-spin" size={16} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: number;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, danger, size = 32, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
        active ? "bg-star/15 text-star" : danger ? "text-bad hover:bg-bad/15" : "text-fg-2 hover:bg-raised hover:text-fg",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-semibold text-fg-2">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="text-[12.5px] text-bad">{error}</p> : hint ? <p className="text-[12.5px] text-fg-3">{hint}</p> : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-[10px] bg-canvas/70 px-3 text-[15px] text-fg placeholder:text-fg-3 outline-none ring-1 ring-line/10 transition-shadow focus:ring-2 focus:ring-star/70";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  right?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, right, className, id, ...rest }, ref) {
  const auto = useId();
  const input = (
    <div className="relative">
      <input ref={ref} id={id ?? auto} className={clsx(inputCls, "h-11", right && "pr-10", error && "ring-2 ring-bad/70", className)} aria-invalid={!!error} {...rest} />
      {right && <div className="absolute inset-y-0 right-2 flex items-center">{right}</div>}
    </div>
  );
  if (!label && !hint && !error) return input;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id ?? auto}>
      {input}
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, className, id, ...rest }, ref) {
  const auto = useId();
  const el = <textarea ref={ref} id={id ?? auto} className={clsx(inputCls, "min-h-24 resize-y py-2.5 leading-snug", className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id ?? auto}>
      {el}
    </Field>
  );
});

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-star" : "bg-overlay"
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-[cubic-bezier(.3,1.4,.6,1)]",
          checked && "translate-x-4"
        )}
      />
    </button>
  );
}

export function SettingRow({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    // Wraps on narrow screens: the control drops below its label instead of covering it.
    <div className={clsx("flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3", className)}>
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-[15px] font-medium text-fg">{title}</div>
        {hint && <div className="mt-0.5 text-[13px] text-fg-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  format,
  className,
  marker,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
  /** Live level overlay 0..1 (mic meter). */
  marker?: number;
}) {
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  // The native thumb (16px) travels inside the input's width minus its own
  // size, so fills end at the thumb's centre, not at a plain percentage.
  const toThumb = (f: number) => `calc(${f} * (100% - 16px) + 8px)`;
  return (
    <div className={clsx("flex h-6 items-center gap-3", className)}>
      <div className="relative flex h-6 min-w-0 flex-1 items-center">
        <div className="absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-overlay">
          {marker !== undefined && <div className="absolute inset-y-0 left-0 bg-ok/60 transition-[width] duration-75" style={{ width: toThumb(Math.min(1, marker)) }} />}
          <div className="absolute inset-y-0 left-0 rounded-full bg-star" style={{ width: toThumb(frac), opacity: marker !== undefined ? 0.35 : 1 }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={format?.(value)}
          className="relative z-10 m-0 h-6 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgb(var(--star)/0.35)]"
        />
      </div>
      {format && <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-fg-2">{format(value)}</span>}
    </div>
  );
}

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx("anim-spin text-fg-3", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line/20 bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{children}</kbd>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-[10px] bg-canvas/70 p-1 ring-1 ring-line/10 [scrollbar-width:none]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors",
            o.value === value ? "bg-raised text-fg shadow-sm" : "text-fg-3 hover:text-fg"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Click-to-copy with a brief confirmation. */
export function useCopy(): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    done,
    (text: string) => {
      void navigator.clipboard?.writeText(text).catch(() => {});
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1400);
    },
  ];
}
