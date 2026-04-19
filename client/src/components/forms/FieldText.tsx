import type { AnyFieldApi } from '@tanstack/react-form';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { cn } from '#/lib/utils';

type FieldTextProps = {
  field: AnyFieldApi;
  label: string;
  type?: React.HTMLInputTypeAttribute;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
};

export function FieldText({
  field,
  label,
  type = 'text',
  placeholder,
  autoComplete,
  disabled,
}: FieldTextProps) {
  const errors = field.state.meta.errors;
  const hasError = errors.length > 0 && field.state.meta.isTouched;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={field.name} className="text-sm font-medium text-foreground">
        {label}
      </Label>
      <Input
        id={field.name}
        name={field.name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        value={field.state.value ?? ''}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={hasError || undefined}
      />
      {hasError && (
        <p className={cn('text-xs text-destructive')}>
          {errors
            .map((e: unknown) =>
              typeof e === 'string' ? e : (e as { message?: string })?.message,
            )
            .filter(Boolean)
            .join(' • ')}
        </p>
      )}
    </div>
  );
}
