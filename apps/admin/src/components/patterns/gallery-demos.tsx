'use client';

import { useState } from 'react';
import { Toast } from '../ui/toast';
import { Button } from '../ui/button';

/** Gallery-only: shows a toast on demand. */
export function ToastDemo() {
  const [count, setCount] = useState(0);
  return (
    <div className="gallery-row">
      <Button variant="secondary" onClick={() => setCount((c) => c + 1)}>
        Show a toast
      </Button>
      <Toast key={count} message={count > 0 ? `Settings saved (${count}).` : undefined} />
    </div>
  );
}
