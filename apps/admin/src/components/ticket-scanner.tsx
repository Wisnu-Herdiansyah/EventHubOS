'use client';

import { useEffect, useRef, useState } from 'react';
import { ticketIdFromScan } from '@/lib/ticket-scan';
import { Button } from './ui/button';

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}

/**
 * Reads ticket QR codes with the device camera (ADR-0029). Uses the browser's built-in barcode
 * reader where there is one and a bundled decoder (loaded only when needed) elsewhere, such as
 * iPhone Safari. Frames never leave the device. Hardware scanners don't need this: they type
 * into the search box.
 */
export function TicketScanner(props: { onTicket: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The latest callback, without restarting the camera when the parent re-renders.
  const onTicket = useRef(props.onTicket);
  onTicket.current = props.onTicket;

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const canvas = document.createElement('canvas');

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        setProblem(
          name === 'NotAllowedError'
            ? 'Camera access is blocked. Allow the camera for this site, or type the name or ticket code.'
            : 'No camera is available. Type the name, or use a handheld scanner.',
        );
        setOpen(false);
        return;
      }
      if (stopped || !video.current) return stream.getTracks().forEach((t) => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      const native = window.BarcodeDetector
        ? new window.BarcodeDetector({ formats: ['qr_code'] })
        : null;
      const fallback = native ? null : (await import('jsqr')).default;

      const tick = async () => {
        const v = video.current;
        if (stopped || !v) return;
        let text: string | null = null;
        if (v.readyState >= 2) {
          if (native) {
            text = (await native.detect(v).catch(() => []))[0]?.rawValue ?? null;
          } else if (fallback) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx && canvas.width > 0) {
              ctx.drawImage(v, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = fallback(img.data, img.width, img.height)?.data ?? null;
            }
          }
        }
        const id = text ? ticketIdFromScan(text) : null;
        if (id) {
          setOpen(false);
          onTicket.current(id);
          return;
        }
        timer = setTimeout(() => void tick(), 200);
      };
      void tick();
    }
    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div className="ticket-scanner">
      {open ? (
        <div className="ticket-scanner__panel" role="group" aria-label="Ticket scanner">
          <video ref={video} className="ticket-scanner__video" muted playsInline aria-hidden />
          <p className="field__hint">Hold the ticket’s QR code inside the frame.</p>
          <Button variant="secondary" onClick={close}>
            Stop scanning
          </Button>
        </div>
      ) : (
        <Button
          ref={button}
          variant="secondary"
          icon="camera"
          onClick={() => {
            setProblem(null);
            setOpen(true);
          }}
        >
          Scan ticket
        </Button>
      )}
      {problem ? (
        <p className="field__error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
