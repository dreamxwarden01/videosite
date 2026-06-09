import { useEffect, useRef, useState } from 'react';

/**
 * Watches window-level drag-and-drop events while `enabled` is true.
 *
 * Returns `{ dragActive }`. The flag flips true on the first dragenter
 * carrying files and false again when the drag leaves the window (or a
 * drop fires). Use it to show a full-screen overlay that becomes the
 * effective drop zone, so the user doesn't have to land precisely on
 * the modal's small dropzone div.
 *
 * `onFile(file)` is invoked with the first file from a drop event.
 *
 * Files-only filtering: dragenter fires for anything (text selections,
 * DOM nodes, image URLs from other tabs). We only enter the active
 * state when the dataTransfer advertises a "Files" type, so dragging a
 * text snippet over the page doesn't open the overlay.
 *
 * Drag depth: every child element fires its own dragenter/dragleave
 * pair as the cursor crosses element boundaries. To avoid the overlay
 * flickering, we count enters minus leaves; the active state stays true
 * as long as the counter is positive. A `drop` event resets it
 * regardless of count, and a clean transition to count=0 turns it off.
 *
 * `onFile` is captured into a ref so the callback can be redefined per
 * render without re-registering listeners — keeps the dependency array
 * stable and the document listeners attached for the modal's lifetime.
 */
export default function useFullWindowDrop({ enabled, onFile }) {
    const [dragActive, setDragActive] = useState(false);
    const onFileRef = useRef(onFile);
    onFileRef.current = onFile;

    useEffect(() => {
        if (!enabled) {
            // Clean reset if the consumer disables mid-drag (e.g. the
            // modal closes while a file is hovering): drop the overlay
            // and any pending state on the floor.
            setDragActive(false);
            return undefined;
        }

        let depth = 0;

        const isFileDrag = (e) => {
            // dataTransfer.types is a DOMStringList during dragenter;
            // both contains() and Array.from include() work, but the
            // for-of loop is the most portable across older browsers.
            if (!e.dataTransfer || !e.dataTransfer.types) return false;
            for (const t of e.dataTransfer.types) {
                if (t === 'Files') return true;
            }
            return false;
        };

        const handleEnter = (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth++;
            if (depth === 1) setDragActive(true);
        };
        const handleLeave = (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = Math.max(0, depth - 1);
            if (depth === 0) setDragActive(false);
        };
        const handleOver = (e) => {
            if (!isFileDrag(e)) return;
            // Without preventDefault here the browser refuses the drop
            // and navigates to file:// instead — long-standing HTML5
            // DnD quirk.
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };
        const handleDrop = (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = 0;
            setDragActive(false);
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file && onFileRef.current) onFileRef.current(file);
        };

        window.addEventListener('dragenter', handleEnter);
        window.addEventListener('dragleave', handleLeave);
        window.addEventListener('dragover', handleOver);
        window.addEventListener('drop', handleDrop);
        return () => {
            window.removeEventListener('dragenter', handleEnter);
            window.removeEventListener('dragleave', handleLeave);
            window.removeEventListener('dragover', handleOver);
            window.removeEventListener('drop', handleDrop);
        };
    }, [enabled]);

    return { dragActive };
}
