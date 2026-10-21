import { CheckOutlined } from '@ant-design/icons'
import { colors, type Color } from '../domain/todo.js'

export default function ColorPicker({
  value,
  onChange,
}: {
  value: Color
  onChange: (color: Color) => void
}) {
  const labels = {
    peach: '杏橙',
    lavender: '薰衣草',
    mint: '薄荷绿',
    sky: '晴空蓝',
    rose: '蔷薇粉',
  }
  return (
    <div className="color-picker" role="group" aria-label="卡片颜色">
      {colors.map((color) => (
        <button
          type="button"
          key={color}
          className={`color-swatch ${color} ${value === color ? 'selected' : ''}`}
          onClick={() => onChange(color)}
          aria-pressed={value === color}
          aria-label={labels[color]}
        >
          {value === color && <CheckOutlined />}
        </button>
      ))}
    </div>
  )
}
