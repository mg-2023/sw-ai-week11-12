import './styles/main.css'
import { startApp } from './app/app.ts'

const root = document.querySelector('#app')
if (!root) throw new Error('#app 요소를 찾지 못했습니다.')

startApp(root)
