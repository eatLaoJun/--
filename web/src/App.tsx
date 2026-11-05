import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { TasksProvider } from "./TasksContext";
import { TaskConsolePage } from "./pages/TaskConsolePage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { DiffEvidencePage } from "./pages/DiffEvidencePage";
import { TimelinePage } from "./pages/TimelinePage";

export default function App() {
  return (
    <TasksProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<TaskConsolePage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="tasks/:taskId/diff" element={<DiffEvidencePage />} />
          <Route path="tasks/:taskId/timeline" element={<TimelinePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TasksProvider>
  );
}
