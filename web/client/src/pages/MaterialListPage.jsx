import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { apiGet, apiDelete } from '../api';
import Pagination from '../components/Pagination';
import UploadMaterialModal from '../components/UploadMaterialModal';
import EditMaterialModal from '../components/EditMaterialModal';
import LoadingSpinner from '../components/LoadingSpinner';

function formatFileSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function MaterialListPage() {
  const { courseId } = useParams();
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [courseName, setCourseName] = useState('');
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState(null);

  const fetchMaterials = useCallback(async () => {
    try {
      const { data, ok } = await apiGet(`/api/materials/courses/${courseId}`);
      if (ok && data) {
        setCourseName(data.courseName || '');
        setMaterials(data.materials || []);
      }
    } catch (err) {
      showToast('Failed to load materials.', 'error');
    } finally {
      setLoading(false);
    }
  }, [courseId, showToast]);

  useEffect(() => {
    fetchMaterials();
  }, [fetchMaterials]);

  useEffect(() => {
    if (courseName) {
      document.title = `${courseName} - Materials - ${siteName}`;
    }
  }, [courseName, siteName]);

  const perms = user?.permissions || {};

  const handleDownload = async (materialId, mode) => {
    try {
      const url = mode === 'view'
        ? `/api/materials/${materialId}/download?mode=view`
        : `/api/materials/${materialId}/download`;
      const { data, ok } = await apiGet(url);
      if (ok && data?.downloadUrl) {
        window.open(data.downloadUrl, '_blank');
      } else {
        showToast(data?.error || 'Failed to get download link.');
      }
    } catch (err) {
      showToast(mode === 'view' ? 'Failed to open file.' : 'Download failed.');
    }
  };

  const handleDelete = async (material) => {
    const ok = await confirm(`Delete "${material.filename}"? This cannot be undone.`);
    if (!ok) return;
    try {
      const { ok: deleteOk, data } = await apiDelete(`/api/materials/${material.material_id}`);
      if (deleteOk) {
        showToast('Material deleted.', 'success');
        fetchMaterials();
      } else {
        showToast(data?.error || 'Failed to delete material.');
      }
    } catch (err) {
      showToast('Failed to delete material.');
    }
  };

  if (!user?.permissions?.accessAttachments) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const total = materials.length;
  const totalPages = Math.ceil(total / limit);
  const paginatedMaterials = materials.slice((page - 1) * limit, page * limit);

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      {/* Header card bar */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: '16px' }}>
        <div className="flex-between">
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <Link to="/admin/materials" className="btn btn-secondary btn-sm">Back</Link>
            <h2 style={{ margin: 0 }}>{courseName}</h2>
          </div>
          {perms.uploadAttachments && (
            <button className="btn btn-primary" onClick={() => setShowUploadModal(true)}>
              Upload Material
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Week</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedMaterials.map(m => (
                <tr key={m.material_id}>
                  <td>{m.filename}</td>
                  <td>{m.week || '-'}</td>
                  <td>{formatFileSize(m.file_size)}</td>
                  <td>{new Date(m.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {m.filename.toLowerCase().endsWith('.pdf') && (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleDownload(m.material_id, 'view')}
                        >
                          View
                        </button>
                      )}
                      <button
                        className={`btn btn-sm ${m.filename.toLowerCase().endsWith('.pdf') ? 'btn-secondary' : 'btn-primary'}`}
                        onClick={() => handleDownload(m.material_id)}
                      >
                        Download
                      </button>
                      {perms.uploadAttachments && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditingMaterial(m)}
                        >
                          Edit
                        </button>
                      )}
                      {perms.deleteAttachments && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(m)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr>
                  <td colSpan="5" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>
                    No materials uploaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          onPageChange={setPage}
          onLimitChange={(newLimit) => { setLimit(newLimit); setPage(1); }}
          itemLabel="material"
        />
      </div>

      {showUploadModal && (
        <UploadMaterialModal
          isOpen
          courses={[{ course_id: parseInt(courseId), course_name: courseName }]}
          preselectedCourseId={courseId}
          preselectedCourseName={courseName}
          existingMaterials={materials}
          onClose={() => setShowUploadModal(false)}
          onUploadComplete={() => { setShowUploadModal(false); fetchMaterials(); }}
        />
      )}

      <EditMaterialModal
        isOpen={!!editingMaterial}
        onClose={() => setEditingMaterial(null)}
        onEdited={() => { setEditingMaterial(null); fetchMaterials(); }}
        material={editingMaterial}
      />
    </div>
  );
}
