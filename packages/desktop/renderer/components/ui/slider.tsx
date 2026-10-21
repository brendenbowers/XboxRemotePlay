import React from 'react'

interface SliderProps {
  id: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  label?: string;
  svg?: React.ReactNode; // uses label if not defined
  style?: React.CSSProperties;
}

const Slider: React.FC<SliderProps> = ({
    id,
    min,
    max,
    step,
    value,
    onChange,
    label,
    svg,
    style,
}) => {
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = parseFloat(event.target.value)
        onChange(newValue)
    }
    const handleSvgClick = () => {
    //click to mute/unmute lazy impl. (should remember last value to avoid 'rip headphone users' moments..)
        if (value === min) onChange(max)
        else onChange(min)
    }
    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        event.preventDefault()
        return false
    }

    return (
        <div className="slider-container" style={style}>
            {svg ? (
                <button
                    className="slider-icon"
                    onClick={handleSvgClick}
                    tabIndex={0}
                    role="button"
                    aria-label="Reset volume"
                >
                    {svg}
                </button>
            ) : (
                label && (
                    <label htmlFor={id} style={{ marginRight: 10 }}>
                        {label}:
                    </label>
                )
            )}
            <input
                id={id}
                className="slider"
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
            />
            <span className="slider-percentage" style={{ marginLeft: 10 }}>
                {Math.round(value * 100)}%
            </span>
        </div>
    )
}

export default Slider
