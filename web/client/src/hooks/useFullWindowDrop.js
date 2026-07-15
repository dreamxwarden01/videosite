import { useEffect, useRef, useState } from 'react';

/**
 * Watches window-level drag-and-drop events while `enabled` is true.
 *
 * Returns `{ dragActive, refusing }`. `dragActive` flips true on the first
 * dragenter carrying files and false again when the drag leaves the window
 * (or a drop fires). Use it to show a full-screen overlay that becomes the
 * effective drop zone, so the user doesn't have to land precisely on the
 * modal's small dropzone div.
 *
 * `onFiles(files)` is invoked with an array of the dropped files — sliced to
 * a single element when `multiple` is false.
 *
 * `refuse`: keep listening and keep showing the overlay, but reject the drop.
 * The cursor gets dropEffect 'none', the drop is swallowed, and `refusing` is
 * true so the overlay can turn red. This is what an in-progress upload wants:
 * silently ignoring the drop would read as a bug, and tearing the listeners
 * down would let the browser navigate to file:// instead.
 *
 * Files-only filtering: dragenter fires for anything (text selections, DOM
 * nodes, image URLs from other tabs). We only enter the active state when the
 * dataTransfer advertises a "Files" type, so dragging a text snippet over the
 * page doesn't open the overlay.
 *
 * Drag depth: every child element fires its own dragenter/dragleave pair as
 * the cursor crosses element boundaries. To avoid the overlay flickering, we
 * count enters minus leaves; the active state stays true as long as the
 * counter is positive. A `drop` event resets it regardless of count, and a
 * clean transition to count=0 turns it off.
 *
 * `onFiles` and `refuse` are captured into refs so they can be redefined per
 * render without re-registering listeners — keeps the dependency array stable
 * and the document listeners attached for the modal's lifetime. In particular
 * `refuse` must NOT be a dependency: flipping it mid-drag would tear down the
 * listeners and strand the depth counter, leaving the overlay stuck open.
 */
export default function useFullWindowDrop({ enabled, multiple = false, refuse = false, onFiles }) {
    const [dragActive, setDragActive] = useState(false);
    const onFilesRef = useRef(onFiles);
    onFilesRef.current = onFiles;
    const refuseRef = useRef(refuse);
    refuseRef.current = refuse;
    const multipleRef = useRef(multiple);
    multipleRef.current = multiple;

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
            // DnD quirk. That applies while refusing too, which is why
            // we keep the listener attached rather than disabling it.
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = refuseRef.current ? 'none' : 'copy';
        };
        const handleDrop = (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = 0;
            setDragActive(false);
            if (refuseRef.current) return;
            const dropped = e.dataTransfer && e.dataTransfer.files
                ? Array.from(e.dataTransfer.files)
                : [];
            if (!dropped.length || !onFilesRef.current) return;
            onFilesRef.current(multipleRef.current ? dropped : dropped.slice(0, 1));
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

    return { dragActive, refusing: dragActive && refuse };
}
