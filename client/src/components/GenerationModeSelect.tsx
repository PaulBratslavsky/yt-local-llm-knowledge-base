import { Label } from '#/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select';
import type { GenerationMode } from '#/lib/validations/post';

type Props = {
  value: GenerationMode;
  onChange: (next: GenerationMode) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Rendered inline with the Select trigger (e.g. a Force retry button). */
  trailing?: React.ReactNode;
};

const OPTIONS: Record<GenerationMode, { label: string; description: string }> = {
  auto: {
    label: 'Auto (recommended)',
    description: 'Picks based on transcript length — map-reduce kicks in around 60 min.',
  },
  single: {
    label: 'Single-pass',
    description: 'One model call over the full transcript. Faster; best for videos under ~60 min.',
  },
  mapreduce: {
    label: 'Map-reduce',
    description: 'Summarizes each chunk then reduces. Slower but more focused on long or dense videos.',
  },
};

export function GenerationModeSelect({
  value,
  onChange,
  disabled,
  id = 'generation-mode',
  className,
  trailing,
}: Readonly<Props>) {
  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      <Label htmlFor={id} className="sr-only">
        Generation mode
      </Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as GenerationMode)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          style={{ height: '2.5rem' }}
          className="flex-1 rounded-full px-4"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(OPTIONS) as GenerationMode[]).map((key) => (
            <SelectItem key={key} value={key}>
              {OPTIONS[key].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {trailing}
    </div>
  );
}

export { OPTIONS as GenerationModeOptions };
