import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Searchable course-picker input.
 *
 * Renders the matching-course dropdown via a React portal anchored to
 * document.body with `position: fixed`. This is the only way to escape
 * the upload-modal's `max-height + overflow-y: auto` container — a
 * normal `position: absolute` dropdown gets clipped by the modal's
 * scroll context, forcing the user to scroll the modal to see the rest
 * of the options. The portaled version sits on top of everything
 * (z-index above the modal overlay) and the input's
 * getBoundingClientRect drives the per-render coords, with scroll /
 * resize listeners keeping it pinned to the input.
 *
 * Outside-click closes the dropdown when the click lands outside both
 * the input wrap and the portaled menu — checking only one of them
 * would close the menu on its own clicks (the menu isn't a descendant
 * of the wrap anymore).
 *
 * Props:
 *   courses          — full course array, each { course_id, course_name }
 *   value            — the currently selected course_id (string or number)
 *   onChange(id)     — called with the new course_id when the user picks
 *   disabled         — passthrough to the underlying input
 *   placeholder      — input placeholder text
 */
export default function CourseSelector({ courses, value, onChange, disabled, placeholder }) {
    const wrapRef = useRef(null);
    const menuRef = useRef(null);
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState(null);

    const selected = courses.find(c => String(c.course_id) === String(value));
    const filtered = courses.filter(c =>
        c.course_name.toLowerCase().includes(search.toLowerCase())
    );

    // Reposition the portaled menu. Runs on open, on window scroll
    // (capture-true so the modal's inner scroll also triggers it), and
    // on window resize. Reading the rect every event is cheap and
    // beats the alternative (closing the menu on every scroll tick).
    const updatePos = useCallback(() => {
        if (!wrapRef.current) return;
        const rect = wrapRef.current.getBoundingClientRect();
        setPos({
            top: rect.bottom + 2,
            left: rect.left,
            width: rect.width,
        });
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        updatePos();
        window.addEventListener('scroll', updatePos, true);
        window.addEventListener('resize', updatePos);
        return () => {
            window.removeEventListener('scroll', updatePos, true);
            window.removeEventListener('resize', updatePos);
        };
    }, [open, updatePos]);

    useEffect(() => {
        function handleClick(e) {
            const inWrap = wrapRef.current && wrapRef.current.contains(e.target);
            const inMenu = menuRef.current && menuRef.current.contains(e.target);
            if (!inWrap && !inMenu) setOpen(false);
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    return (
        <div className="course-select-wrap" ref={wrapRef}>
            <input
                type="text"
                className="form-control"
                value={open ? search : (selected?.course_name || search)}
                onChange={e => {
                    setSearch(e.target.value);
                    onChange('');
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                disabled={disabled}
                placeholder={placeholder || 'Search for a course...'}
                autoComplete="off"
            />
            {open && filtered.length > 0 && pos && createPortal(
                <div
                    ref={menuRef}
                    className="course-select-dropdown course-select-dropdown-portal"
                    style={{
                        position: 'fixed',
                        top: pos.top,
                        left: pos.left,
                        width: pos.width,
                    }}
                >
                    {filtered.map(c => (
                        <div
                            key={c.course_id}
                            className="course-select-option"
                            onClick={() => {
                                onChange(String(c.course_id));
                                setSearch(c.course_name);
                                setOpen(false);
                            }}
                        >
                            {c.course_name}
                        </div>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
}
