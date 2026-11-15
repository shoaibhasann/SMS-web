import {redirect} from "next/navigation";export default function Home(){redirect("/dashboard")} // the proxy and /dashboard send signed-out visitors to /login
