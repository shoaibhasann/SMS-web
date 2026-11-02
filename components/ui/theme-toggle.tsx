"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
export function ThemeToggle(){const {theme,setTheme}=useTheme();const [mounted,setMounted]=useState(false);useEffect(()=>setMounted(true),[]);if(!mounted)return <div className="h-10 w-28 rounded-xl border border-[var(--border)]"/>;return <div className="flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1"><button onClick={()=>setTheme("light")} className={`rounded-lg p-2 ${theme==="light"?"bg-blue-50 text-blue-600 dark:bg-blue-950":"muted"}`}><Sun size={16}/></button><button onClick={()=>setTheme("dark")} className={`rounded-lg p-2 ${theme==="dark"?"bg-blue-50 text-blue-600 dark:bg-blue-950":"muted"}`}><Moon size={16}/></button><button onClick={()=>setTheme("system")} className={`rounded-lg p-2 ${theme==="system"?"bg-blue-50 text-blue-600 dark:bg-blue-950":"muted"}`}><Monitor size={16}/></button></div>}
