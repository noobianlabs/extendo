import { Check, ChevronUp, Cpu } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderInfo } from '@extendo/contracts';
import styles from './console.module.css';

/** Provider and model for the next message, in the sidebar footer where the session lives. */
export function ModelPicker({
  providers, selection, onSelect,
}: {
  providers: ProviderInfo[];
  selection: { provider: string; model?: string };
  onSelect: (next: { provider: string; model: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = providers.find(({ id }) => id === selection.provider);
  const label = current?.name ?? selection.provider;
  const model = selection.model ?? current?.model ?? selection.provider;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <div className={`${styles.picker} extendo-chrome-picker`} ref={root}>
    <button type="button" className={styles.pickerButton} aria-expanded={open} aria-controls={menuId}
      title={`${label} · ${model}`} onClick={() => setOpen((value) => !value)}>
      <Cpu size={14} aria-hidden="true" />
      <bdi className={styles.pickerLabel} dir="auto">{label}</bdi>
      <bdi className={styles.pickerModel} dir="auto" title={model}>{model}</bdi>
      <ChevronUp size={13} aria-hidden="true" className={styles.pickerChevron} data-open={open} />
    </button>
    {open && <div className={styles.pickerMenu} id={menuId} role="menu" aria-label="Model">
      {providers.length === 0 && <p className={styles.empty}>No providers configured.</p>}
      {providers.map((provider) => {
        const selected = provider.id === selection.provider;
        const modelId = selected ? selection.model ?? provider.model : provider.model;
        return <button key={provider.id} type="button" role="menuitemradio" aria-checked={selected}
          className={styles.pickerItem} disabled={!provider.configured}
          title={provider.configured ? `${provider.name} · ${modelId}` : `${provider.name} needs configuration`}
          onClick={() => {
            onSelect({ provider: provider.id, model: modelId });
            setOpen(false);
          }}>
          <span className={styles.pickerItemName} dir="auto">{provider.name}</span>
          <bdi className={styles.pickerItemModel} dir="auto">{modelId}</bdi>
          {selected && <Check size={13} aria-hidden="true" />}
        </button>;
      })}
    </div>}
  </div>;
}
